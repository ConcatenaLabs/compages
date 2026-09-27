// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The parts of CompagesVault the receiver uses, all of them public
///      functions of the deployed vault (VERSION 3 and later).
interface ICompagesVault {
    function owner() external view returns (address);
    function guardian() external view returns (address);
    function depositsPaused() external view returns (bool);
    function depositCount() external view returns (uint256);
    function depositToken(address token, uint256 amount, string calldata sequentiaAddress) external;
}

/// @dev The LayerZero OFT v2 views the receiver checks its configuration
///      against. Signatures match LayerZero-v2
///      packages/layerzero-v2/evm/oapp/contracts/oft/interfaces/IOFT.sol
///      (token) and oapp/interfaces/IOAppCore.sol (endpoint).
interface IOftV2 {
    function token() external view returns (address);
    function endpoint() external view returns (address);
}

/// @title CompagesOftReceiver - LayerZero OFT arrivals into the Compages vault
/// @notice Receives a LayerZero OFT v2 token (USDT0, Tether's OFT) sent from
///         another chain with a compose message, and moves it into the
///         CompagesVault as a deposit, as liquidity, or as an arrival kept
///         for refunding. It is the OFT counterpart of the vault's
///         receiveCctp, built as a separate contract so that a vault already
///         deployed (the vault is deliberately not upgradeable) can take OFT
///         deposits without being replaced.
///
/// Arrival. An OFT send names this contract as recipient (`to`) and carries a
/// compose message. On this chain the OFT credits the tokens here in one
/// transaction and queues the compose message with the LayerZero endpoint;
/// the endpoint delivers it to lzCompose in a later one, which anyone may
/// trigger. The compose message is the OFT's own encoding
/// (OFTComposeMsgCodec): source nonce, source endpoint id, amount credited,
/// the sender on the source chain, then the sender's own bytes. Those bytes
/// say what the tokens are for, in the same words as CCTP hookData:
/// - COMPOSE_DEPOSIT_TAG followed by a Sequentia address (14 to 120 bytes):
///   a deposit. The receiver deposits the tokens with the vault's
///   depositToken, so the vault emits its ordinary Deposited event (`from` is
///   this contract) under its own deposit counter, and the receiver emits
///   OftDeposit with the same nonce, carrying the source chain and sender.
/// - exactly COMPOSE_REBALANCE_TAG: liquidity from another escrow. The tokens
///   go to the vault by plain transfer and RebalancedIn is emitted here.
/// - anything else: the tokens still go to the vault, by plain transfer, and
///   OftUnrecognized reports them for refunding. So does a well-formed deposit
///   the vault refuses under its deposit rules (minimum, cap, blocked token):
///   the tokens have already arrived, so the rules cannot keep them out, only
///   decide that they are refunded rather than bridged.
/// Deposits and unrecognised arrivals revert while the vault's deposits are
/// paused, and every arrival reverts while the receiver is disabled. A
/// reverted compose stays queued at the endpoint and can be delivered again
/// later, while its tokens wait here.
///
/// Authentication. Only the configured endpoint may call lzCompose, and only
/// for a message queued by the configured OFT: the endpoint delivers a
/// compose only if its hash matches one that `from` queued for this contract.
/// The amount the message states must be held here; each guid is accepted
/// once. The amount reported is the vault's measured balance change.
///
/// Roles. The receiver has no keys of its own. It reads the vault's: the
/// vault's owner configures it, enables it and sweeps it; the vault's
/// guardian (or owner) can disable it. Tokens leave the receiver only into
/// the vault.
contract CompagesOftReceiver {
    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 public constant VERSION = 1;

    /// @notice Compose bytes of a deposit: this ASCII prefix followed by the
    ///         Sequentia address. The same tag as CCTP hookData.
    bytes public constant COMPOSE_DEPOSIT_TAG = "compages:deposit:";

    /// @notice Compose bytes of liquidity arriving from another chain's
    ///         escrow: exactly these bytes.
    bytes public constant COMPOSE_REBALANCE_TAG = "compages:rebalance";

    /// @notice Gas given to the vault's depositToken.
    /// @dev A deposit the vault refuses becomes an unrecognised arrival rather
    ///      than a revert, so a caller supplying too little gas could otherwise
    ///      turn a valid deposit into a refund. The vault always gets exactly
    ///      this much, and the receiver refuses to attempt the deposit unless
    ///      the transaction can provide it (DEPOSIT_GAS_FLOOR); a refusal is
    ///      then the vault's own. It is several times what depositToken
    ///      with a USDT-style token uses. A compose therefore needs about 400k
    ///      gas in all; with less it reverts and can be delivered again.
    uint256 public constant DEPOSIT_GAS = 200_000;

    /// @dev DEPOSIT_GAS plus the 1/64 the EVM withholds (EIP-150) plus the
    ///      call's own cost, with margin.
    uint256 private constant DEPOSIT_GAS_FLOOR = DEPOSIT_GAS * 64 / 63 + 20_000;

    /// @dev OFT v2 compose message layout (OFTComposeMsgCodec.sol): nonce
    ///      0..8, srcEid 8..12, amountLD 12..44, composeFrom 44..76, the
    ///      sender's compose bytes 76...
    uint256 private constant SRC_EID = 8;
    uint256 private constant AMOUNT_LD = 12;
    uint256 private constant COMPOSE_FROM = 44;
    uint256 private constant COMPOSE_MSG = 76;

    /// @dev Transient-storage slot of the reentrancy lock (EIP-1153).
    uint256 private constant REENTRANCY_TSLOT = 0;

    uint8 private constant DEPOSIT = 0;
    uint8 private constant REBALANCE = 1;
    uint8 private constant UNRECOGNIZED = 2;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    ICompagesVault public immutable vault;

    /// @notice The LayerZero EndpointV2 on this chain, the OFT whose compose
    ///         messages are accepted, and the token that OFT credits (for an
    ///         OFT adapter, the underlying token it locks and releases).
    ///         All zero means unconfigured.
    address public endpoint;
    address public oft;
    address public token;

    /// @notice Whether lzCompose accepts anything. Set by the vault's owner;
    ///         the guardian can clear it.
    bool public enabled;

    /// @notice Compose guids already accepted.
    mapping(bytes32 => bool) public composed;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @notice A deposit arrived over the OFT. Same transaction and same
    ///         `nonce` as the vault's Deposited event; `sender` is the account
    ///         that sent it on chain `srcEid`, where a refund goes back to.
    event OftDeposit(uint256 indexed nonce, uint32 indexed srcEid, bytes32 sender, bytes32 guid, uint256 amount);
    /// @notice Tokens arrived tagged as liquidity, not a deposit. Same
    ///         signature as the vault's RebalancedIn, with the LayerZero
    ///         endpoint id in place of the CCTP domain.
    event RebalancedIn(address indexed token, uint256 amount, uint32 indexed sourceDomain, bytes32 sender);
    /// @notice Tokens arrived whose compose bytes are neither a well-formed
    ///         deposit nor the rebalance tag, or a deposit the vault refused.
    ///         They are in the vault and reported so they can be returned to
    ///         `sender` on `srcEid`.
    event OftUnrecognized(uint32 indexed srcEid, bytes32 sender, bytes32 guid, uint256 amount, bytes composeMsg);
    /// @notice The vault's owner moved tokens held here into the vault.
    event Swept(address indexed token, uint256 amount);
    event OftSet(
        address previousEndpoint,
        address previousOft,
        address previousToken,
        address endpoint,
        address oft,
        address token
    );
    event EnabledSet(address indexed by, bool wasEnabled, bool enabled);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotOwner();
    error NotGuardianOrOwner();
    error NotEndpoint();
    error NotOft();
    error OftDisabled();
    error OftMisconfigured();
    error OftBadMessage();
    error OftNothingReceived();
    error OftAmountNotReceived(uint256 amount, uint256 held);
    error AlreadyComposed();
    error DepositsArePaused();
    error InsufficientGasForDeposit();
    error DepositNotRecorded();
    error UnexpectedValue();
    error ZeroAddress();
    error ZeroAmount();
    error TokenTransferFailed();
    error Reentrancy();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier nonReentrant() {
        uint256 locked;
        assembly ("memory-safe") {
            locked := tload(REENTRANCY_TSLOT)
        }
        if (locked != 0) revert Reentrancy();
        assembly ("memory-safe") {
            tstore(REENTRANCY_TSLOT, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(REENTRANCY_TSLOT, 0)
        }
    }

    modifier onlyOwner() {
        if (msg.sender != vault.owner()) revert NotOwner();
        _;
    }

    constructor(address vault_) {
        if (vault_ == address(0) || vault_.code.length == 0) revert ZeroAddress();
        vault = ICompagesVault(vault_);
    }

    // ------------------------------------------------------------------
    // Inbound
    // ------------------------------------------------------------------

    /// @notice LayerZero compose callback (ILayerZeroComposer). Called by the
    ///         endpoint with a message the configured OFT queued for this
    ///         contract after crediting the tokens here.
    /// @param from The OApp that queued the message: must be the configured OFT.
    /// @param guid The OFT transfer's LayerZero guid.
    /// @param message OFTComposeMsgCodec encoding of the arrival.
    function lzCompose(address from, bytes32 guid, bytes calldata message, address, bytes calldata)
        external
        payable
        nonReentrant
    {
        if (!enabled) revert OftDisabled();
        if (msg.sender != endpoint) revert NotEndpoint();
        if (from != oft) revert NotOft();
        // The receiver never holds ether, and anyone can deliver the compose
        // again without value.
        if (msg.value != 0) revert UnexpectedValue();
        if (message.length < COMPOSE_MSG) revert OftBadMessage();
        if (composed[guid]) revert AlreadyComposed();
        composed[guid] = true;

        address token_ = token;
        uint256 amount = uint256(bytes32(message[AMOUNT_LD:COMPOSE_FROM]));
        if (amount == 0) revert OftNothingReceived();
        uint256 held = _balanceOf(token_, address(this));
        if (held < amount) revert OftAmountNotReceived(amount, held);

        uint8 kind = _kind(message[COMPOSE_MSG:]);
        // Everything but operator liquidity waits out a deposit pause, so
        // nothing new becomes burnable while the supply is locked.
        if (kind != REBALANCE && vault.depositsPaused()) revert DepositsArePaused();

        if (kind == DEPOSIT && _deposit(token_, amount, guid, message)) return;
        uint256 credited = _toVault(token_, amount);
        if (kind == REBALANCE) {
            emit RebalancedIn(token_, credited, _srcEid(message), _sender(message));
        } else {
            emit OftUnrecognized(_srcEid(message), _sender(message), guid, credited, message[COMPOSE_MSG:]);
        }
    }

    /// @dev Deposit through the vault's depositToken. Returns false, with
    ///      nothing moved, if the vault refused it.
    function _deposit(address token_, uint256 amount, bytes32 guid, bytes calldata message) private returns (bool) {
        address vault_ = address(vault);
        uint256 nonce = vault.depositCount();
        uint256 before = _balanceOf(token_, vault_);
        _approve(token_, vault_, amount);
        if (gasleft() < DEPOSIT_GAS_FLOOR) revert InsufficientGasForDeposit();
        try vault.depositToken{gas: DEPOSIT_GAS}(
            token_, amount, string(message[COMPOSE_MSG + COMPOSE_DEPOSIT_TAG.length:])
        ) {}
        catch {
            _approve(token_, vault_, 0);
            return false;
        }
        _approve(token_, vault_, 0);
        if (vault.depositCount() != nonce + 1) revert DepositNotRecorded();
        uint256 credited = _balanceOf(token_, vault_) - before;
        emit OftDeposit(nonce, _srcEid(message), _sender(message), guid, credited);
        return true;
    }

    function _srcEid(bytes calldata message) private pure returns (uint32) {
        return uint32(bytes4(message[SRC_EID:AMOUNT_LD]));
    }

    /// @dev composeFrom: the account that sent the tokens on the source chain.
    function _sender(bytes calldata message) private pure returns (bytes32) {
        return bytes32(message[COMPOSE_FROM:COMPOSE_MSG]);
    }

    function _kind(bytes calldata payload) private pure returns (uint8) {
        uint256 tagLen = COMPOSE_DEPOSIT_TAG.length;
        if (payload.length >= tagLen && keccak256(payload[:tagLen]) == keccak256(COMPOSE_DEPOSIT_TAG)) {
            uint256 len = payload.length - tagLen;
            return len >= 14 && len <= 120 ? DEPOSIT : UNRECOGNIZED;
        }
        return keccak256(payload) == keccak256(COMPOSE_REBALANCE_TAG) ? REBALANCE : UNRECOGNIZED;
    }

    // ------------------------------------------------------------------
    // Configuration (the vault's owner; the guardian may only disable)
    // ------------------------------------------------------------------

    /// @notice Point the receiver at the LayerZero endpoint on this chain and
    ///         the OFT whose compose messages it accepts. Both zero clears the
    ///         configuration and disables the receiver; otherwise the OFT must
    ///         name the endpoint as its own and report a token.
    function setOft(address endpoint_, address oft_) external onlyOwner {
        address token_;
        if (endpoint_ != address(0) || oft_ != address(0)) {
            if (endpoint_ == address(0) || oft_ == address(0)) revert OftMisconfigured();
            if (IOftV2(oft_).endpoint() != endpoint_) revert OftMisconfigured();
            token_ = IOftV2(oft_).token();
            if (token_ == address(0) || token_.code.length == 0) revert OftMisconfigured();
        } else if (enabled) {
            emit EnabledSet(msg.sender, true, false);
            enabled = false;
        }
        emit OftSet(endpoint, oft, token, endpoint_, oft_, token_);
        endpoint = endpoint_;
        oft = oft_;
        token = token_;
    }

    /// @notice Turn the receiver on or off. Only the vault's owner can turn it
    ///         on, and only once an OFT is configured; the vault's guardian or
    ///         owner can turn it off. Composes refused while it is off stay
    ///         queued at the endpoint.
    function setEnabled(bool on) external {
        if (on) {
            if (msg.sender != vault.owner()) revert NotOwner();
            if (oft == address(0)) revert OftMisconfigured();
        } else if (msg.sender != vault.guardian() && msg.sender != vault.owner()) {
            revert NotGuardianOrOwner();
        }
        emit EnabledSet(msg.sender, enabled, on);
        enabled = on;
    }

    /// @notice Move `amount` of `token_` held here into the vault. For tokens
    ///         that reached the receiver without a compose message, or a
    ///         refund the vault paid to this contract; never for tokens whose
    ///         compose is still waiting to be delivered, which would then
    ///         fail its amount check. The vault is the only destination.
    function sweepToVault(address token_, uint256 amount) external onlyOwner nonReentrant {
        if (token_ == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        emit Swept(token_, _toVault(token_, amount));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Plain transfer into the vault; returns the vault's balance change.
    function _toVault(address token_, uint256 amount) private returns (uint256) {
        address vault_ = address(vault);
        uint256 before = _balanceOf(token_, vault_);
        if (!_callToken(token_, abi.encodeWithSelector(0xa9059cbb, vault_, amount))) revert TokenTransferFailed();
        return _balanceOf(token_, vault_) - before;
    }

    function _approve(address token_, address spender, uint256 amount) private {
        if (!_callToken(token_, abi.encodeWithSelector(0x095ea7b3, spender, amount))) revert TokenTransferFailed();
    }

    /// @dev ERC-20 call that tolerates tokens returning no value (USDT), as in
    ///      CompagesVault._callToken.
    function _callToken(address token_, bytes memory data) private returns (bool ok) {
        uint256 returnSize;
        uint256 returnWord;
        assembly ("memory-safe") {
            ok := call(gas(), token_, 0, add(data, 0x20), mload(data), 0, 0x20)
            returnSize := returndatasize()
            returnWord := mload(0)
        }
        if (ok) ok = returnSize == 0 ? token_.code.length != 0 : (returnSize >= 32 && returnWord == 1);
    }

    function _balanceOf(address token_, address account) private view returns (uint256) {
        (bool ok, bytes memory data) = token_.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length < 32) revert TokenTransferFailed();
        return abi.decode(data, (uint256));
    }
}
