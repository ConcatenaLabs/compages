// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The Circle CCTP V2 entry points the vault uses. Signatures match
///      circlefin/evm-cctp-contracts src/v2/TokenMessengerV2.sol and
///      MessageTransmitterV2.sol.
interface ICctpTokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    function localMessageTransmitter() external view returns (address);
}

interface ICctpMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}

/// @title CompagesVault - Ethereum-side vault of Compages, the Sequentia bridge
/// @notice Holds the ether and ERC-20 tokens locked by an operator-run,
///         custodial bridge into the Sequentia network, and pays them back
///         out against redemptions.
///
/// Deposits. Users deposit ether or any ERC-20 together with the Sequentia
/// address that should receive the bridged asset. The bridge daemon watches
/// Deposited events, issues or reissues the matching Sequentia asset, and
/// sends it to that address. USDC can also arrive from another chain over
/// Circle's CCTP (receiveCctp), so that one escrow here backs a unified USDC
/// asset whatever chain the dollars came from.
///
/// Releases. A redemption burns the bridged asset on Sequentia; the operator
/// then calls release() to pay the locked funds out here, or releaseViaCctp()
/// to pay USDC out on another chain. A deposit whose Sequentia leg cannot
/// happen is paid back with refund() or refundViaCctp(). All four share one
/// replay map keyed by deterministic ids, so no id is ever paid twice.
///
/// Roles. Three keys with deliberately different reach:
/// - owner: intended to be a Safe or a cold key. Sets every role and limit,
///   unpauses, reinstates cancelled releases, rebalances escrow. Two-step
///   transfer, so a mistyped address cannot take the vault.
/// - operator: the daemon's hot key. Releases and refunds, and nothing else.
///   What it can pay immediately is bounded by a per-token rate limit; the
///   rest waits in a timelocked queue.
/// - guardian: an incident-response key. Can pause deposits, pause releases
///   and cancel queued releases. It can never unpause and never move funds,
///   so a leaked guardian key can at worst stop the bridge.
///
/// Rate limit and queue. Each token has a token bucket (capacity, refill per
/// second). A release that fits in the bucket pays at once; one that does not
/// is queued for `releaseDelay` seconds, during which the guardian or owner
/// can cancel it. Anyone may execute a queued release once its delay has
/// passed. A token with no configured bucket has capacity zero, so every
/// release of it is queued: the safe default for an arbitrary ERC-20.
/// Queued releases, and cancelled ones the owner may reinstate, are reserved:
/// no immediate payout or rebalance can spend the funds they will need.
///
/// Undeliverable payouts. A payout the recipient cannot accept (a contract or
/// EIP-7702 account that rejects plain ether, a blocklisted recipient, a
/// paused token) does not revert. The amount is recorded as owed to the
/// recipient and reserved in the vault; the recipient later calls claim() to
/// withdraw it to any address it chooses.
///
/// Trust model: this is an explicitly centralized bridge. The owner can move
/// every unreserved token (rebalanceOut) and the operator can pay any address
/// within its limits; depositors trust the bridge operator. The limits,
/// queue and guardian bound the damage a leaked operator key can do; they do
/// not make the bridge trustless.
///
/// Stablecoin hand-off: a bridged stablecoin issued under an issuer's
/// bridged-to-native standard is meant to be adoptable by that issuer later,
/// which requires this vault to be able to (a) lock the supply on both sides so
/// the two chains reconcile to an exact equality, and (b) let the issuer burn
/// the escrow it is taking responsibility for. Both are built in from the
/// start because neither can be retrofitted: this contract is deliberately not
/// upgradeable, so a vault lacking them could only be replaced, which would
/// mean migrating the escrow and breaking the very continuity the hand-off
/// exists to preserve. See doc/sequentia/bridged-usdc-standard.md in the node
/// repository.
///
/// Unsupported tokens: rebasing tokens whose balance can shrink. The vault
/// reserves owed amounts in token units; a negative rebase can leave the
/// balance below what it owes, after which claims fail until it is topped up.
/// A positive rebase simply adds to the unreserved balance.
contract CompagesVault {
    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    uint256 public constant VERSION = 3;

    /// @notice Bounds on the timelock applied to queued releases. The lower
    ///         bound keeps the queue meaningful: with no delay, a release over
    ///         the rate limit could be executed before anyone could cancel it.
    uint256 public constant MIN_RELEASE_DELAY = 1 hours;
    uint256 public constant MAX_RELEASE_DELAY = 30 days;

    /// @notice sourceDomain reported by RebalancedIn for ether the owner adds
    ///         with fundEther(): no CCTP domain has this number.
    uint32 public constant FUNDING_DOMAIN = type(uint32).max;

    /// @notice Gas forwarded to a recipient or token on a direct release,
    ///         refund or queued execution.
    /// @dev A failed payout is turned into an owed balance rather than a
    ///      revert. If the callee's gas were whatever the caller happened to
    ///      supply, anyone executing a queued release could starve the call
    ///      and force a deferral. So the callee always gets exactly this much,
    ///      and the vault refuses to attempt the payout unless the transaction
    ///      can actually provide it (PAYOUT_GAS_FLOOR). A failure is then the
    ///      recipient's or the token's own doing. 200k is several times any
    ///      standard ERC-20 transfer or smart-wallet receive; a payout that
    ///      needs more is not lost, it becomes owed and claim() forwards all
    ///      available gas.
    uint256 public constant PAYOUT_GAS = 200_000;

    /// @dev PAYOUT_GAS plus the 1/64 the EVM withholds (EIP-150) plus the
    ///      call's own up-front costs (cold access 2600, value transfer 9000,
    ///      new account 25000) with margin.
    uint256 private constant PAYOUT_GAS_FLOOR = PAYOUT_GAS * 64 / 63 + 40_000;

    /// @notice CCTP finality requested for outbound burns: 2000 is Circle's
    ///         "finalized" (standard transfer) threshold.
    uint32 public constant CCTP_FINALITY_FINALIZED = 2000;

    /// @notice hookData of an inbound CCTP transfer that is a deposit: this
    ///         ASCII prefix followed by the Sequentia address.
    bytes public constant CCTP_DEPOSIT_TAG = "compages:deposit:";

    /// @notice hookData of an inbound CCTP transfer that is liquidity arriving
    ///         from another chain's escrow: exactly these bytes.
    bytes public constant CCTP_REBALANCE_TAG = "compages:rebalance";

    /// @dev CCTP V2 message layout (MessageV2.sol): version 0..4,
    ///      sourceDomain 4..8, destinationDomain 8..12, nonce 12..44,
    ///      sender 44..76, recipient 76..108, destinationCaller 108..140,
    ///      minFinalityThreshold 140..144, finalityThresholdExecuted 144..148,
    ///      body 148... Burn body (BurnMessageV2.sol), relative to the body:
    ///      version 0..4, burnToken 4..36, mintRecipient 36..68,
    ///      amount 68..100, messageSender 100..132, maxFee 132..164,
    ///      feeExecuted 164..196, expirationBlock 196..228, hookData 228...
    uint256 private constant MSG_BODY = 148;
    uint256 private constant BURN_HOOK = MSG_BODY + 228;

    /// @dev Transient-storage slot of the reentrancy lock (EIP-1153). Nothing
    ///      else in this contract uses transient storage.
    uint256 private constant REENTRANCY_TSLOT = 0;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    enum ReleaseState {
        None, // never queued: either unknown or settled immediately
        Queued, // waiting for its delay, executable afterwards
        Cancelled, // stopped by the guardian or owner; owner may reinstate
        Executed, // paid out, burned via CCTP, or deferred to an owed balance
        Discarded // cancelled and then dropped by the owner; never payable
    }

    struct QueuedRelease {
        address token;
        uint64 executeAfter;
        ReleaseState state;
        bool isRefund;
        bool viaCctp;
        address to; // address(0) for a CCTP release
        uint32 destinationDomain; // CCTP only
        uint256 amount;
        bytes32 mintRecipient; // CCTP only
        uint256 maxFee; // CCTP only
    }

    /// @dev Token bucket. `available` is the stored level at `updatedAt`; the
    ///      live level adds refill since then, capped at `capacity`.
    struct Bucket {
        uint128 capacity;
        uint128 refillPerSecond;
        uint128 available;
        uint64 updatedAt;
    }

    /// @dev One storage slot per token, read once per deposit.
    struct DepositRules {
        uint128 minDeposit;
        uint120 cap;
        bool blocked;
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @dev operator, both pauses and releaseDelay share one slot: everything
    ///      a release reads about roles and pauses.
    address public operator;
    bool public depositsPaused;

    /// @notice Pausing releases as well as deposits is what makes a supply
    ///         lock real: with both directions stopped, the escrow here and the
    ///         circulating supply on Sequentia stop moving relative to each
    ///         other and can be reconciled exactly.
    bool public releasesPaused;

    /// @notice Seconds a release that exceeds the rate limit waits before it
    ///         can be executed. Applies to releases queued after it is set.
    uint64 public releaseDelay;

    address public owner;
    address public pendingOwner;
    address public guardian;

    /// @notice The stablecoin whose escrow may be burned at hand-off, and the
    ///         only address allowed to burn it. Both are set by the owner near
    ///         the hand-off rather than at deployment, because the issuer names
    ///         its burner address then.
    address public lockedStablecoin;
    address public stablecoinBurner;

    /// @notice Circle CCTP V2 contracts on this chain and the local USDC they
    ///         mint and burn. All zero means CCTP is disabled.
    address public cctpTokenMessenger;
    address public cctpMessageTransmitter;
    address public cctpUsdc;

    /// @notice Monotonic id assigned to every deposit: ether, token or CCTP.
    uint256 public depositCount;

    /// @notice Release and refund ids that have been paid, deferred or queued.
    ///         Set at the moment of payment or queueing, so an id can never be
    ///         paid or queued twice, even after its queued release is cancelled.
    mapping(bytes32 => bool) public processedRedemptions;

    /// @notice Per-token release rate limit. address(0) is ether.
    mapping(address => Bucket) public releaseBuckets;

    /// @notice Per-token deposit rules. address(0) is ether.
    mapping(address => DepositRules) public depositRules;

    /// @notice Payouts the recipient could not accept, claimable by it.
    mapping(address => mapping(address => uint256)) public owed;

    /// @notice Sum of `owed` per token: reserved, never releasable or
    ///         rebalanceable.
    mapping(address => uint256) public owedTotal;

    /// @notice Sum of the amounts of releases currently in the Queued state,
    ///         per token. Left untouched by a stablecoin burn.
    mapping(address => uint256) public queuedTotal;

    /// @notice Sum of the amounts of releases currently in the Cancelled
    ///         state, per token. Their Sequentia side is already settled and
    ///         the owner may reinstate them, so they stay reserved until the
    ///         owner reinstates or discards them.
    mapping(address => uint256) public cancelledTotal;

    mapping(bytes32 => QueuedRelease) private _queue;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @dev token == address(0) means ether. `from` is address(0) for a CCTP
    ///      deposit, whose sender is reported by the CctpDeposit event emitted
    ///      alongside it.
    event Deposited(
        uint256 indexed nonce, address indexed token, address indexed from, uint256 amount, string sequentiaAddress
    );
    /// @notice A deposit arrived over CCTP. Same transaction and same `nonce`
    ///         as its Deposited event; `sender` is the burner on the source
    ///         domain (CCTP's messageSender), where a refund goes back to.
    event CctpDeposit(
        uint256 indexed nonce, uint32 indexed sourceDomain, bytes32 sender, bytes32 cctpNonce, uint256 amount
    );
    /// @notice USDC arrived over CCTP tagged as liquidity, not a deposit.
    event RebalancedIn(address indexed token, uint256 amount, uint32 indexed sourceDomain, bytes32 sender);
    /// @notice A CCTP burn naming this vault as destinationCaller but minting
    ///         to `mintRecipient` was relayed through it. Nothing was credited.
    event CctpForwarded(uint32 indexed sourceDomain, bytes32 indexed mintRecipient, bytes32 cctpNonce);
    /// @notice USDC arrived over CCTP with hookData that is neither a
    ///         well-formed deposit nor the rebalance tag. The dollars are kept
    ///         and reported so the daemon can send them back to `sender` on
    ///         `sourceDomain` with refundViaCctp.
    event CctpUnrecognized(
        uint32 indexed sourceDomain, bytes32 sender, bytes32 cctpNonce, uint256 amount, bytes hookData
    );
    /// @notice Funds reached the recipient against a redemption.
    event Released(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount);
    /// @notice Funds reached the depositor against a refund.
    event Refunded(address indexed token, address indexed to, uint256 amount, bytes32 indexed refundId);
    /// @notice USDC was burned here for minting to `mintRecipient` on
    ///         `destinationDomain`, against a redemption.
    event ReleasedViaCctp(
        bytes32 indexed redemptionId, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount
    );
    /// @notice As ReleasedViaCctp, against a refund.
    event RefundedViaCctp(
        bytes32 indexed refundId, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount
    );
    /// @notice A release or refund exceeded the rate limit and waits in the
    ///         queue. `to` is address(0) for a CCTP release.
    event ReleaseQueued(
        bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount, uint256 executeAfter
    );
    event ReleaseCancelled(bytes32 indexed redemptionId, address indexed by);
    event ReleaseReinstated(bytes32 indexed redemptionId, uint256 executeAfter);
    event ReleaseAmended(
        bytes32 indexed redemptionId,
        bool viaCctp,
        address to,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee
    );
    event ReleaseDiscarded(bytes32 indexed redemptionId);
    /// @notice The recipient could not accept the payout; it is now owed and
    ///         claimable. The id counts as processed.
    event ReleaseDeferred(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount);
    event Claimed(address indexed token, address indexed account, address indexed payTo, uint256 amount);
    /// @dev Distinct from Released so an observer can tell liquidity movements
    ///      apart from user redemptions when auditing the escrow.
    event Rebalanced(address indexed token, address indexed to, uint256 amount, string destination);

    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);
    event ReleaseDelaySet(uint256 previousDelay, uint256 newDelay);
    event ReleaseLimitSet(
        address indexed token,
        uint256 previousCapacity,
        uint256 previousRefillPerSecond,
        uint256 newCapacity,
        uint256 newRefillPerSecond
    );
    event MinDepositSet(address indexed token, uint256 previousMin, uint256 newMin);
    event DepositCapSet(address indexed token, uint256 previousCap, uint256 newCap);
    event TokenBlockedSet(address indexed token, bool wasBlocked, bool blocked);
    event DepositsPausedSet(address indexed by, bool wasPaused, bool paused);
    event ReleasesPausedSet(address indexed by, bool wasPaused, bool paused);
    event StablecoinBurnerSet(
        address indexed token, address indexed burner, address previousToken, address previousBurner
    );
    event LockedStablecoinBurned(address indexed token, uint256 amount);
    event CctpSet(
        address previousTokenMessenger,
        address previousMessageTransmitter,
        address previousUsdc,
        address tokenMessenger,
        address messageTransmitter,
        address usdc
    );

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error NotOwner();
    error NotPendingOwner();
    error NotOperator();
    error NotGuardianOrOwner();
    error NotBurner();
    error DepositsArePaused();
    error ReleasesArePaused();
    error SupplyNotLocked();
    error NoStablecoinConfigured();
    error BurnFailed();
    error ZeroAmount();
    error ZeroAddress();
    error InvalidRecipient();
    error BadSequentiaAddress();
    error TokenIsBlocked();
    error BelowMinDeposit(uint256 minDeposit);
    error DepositCapExceeded(uint256 cap);
    error ValueTooLarge();
    error DelayTooLong();
    error DelayTooShort();
    error AlreadyReleased();
    error NotQueued();
    error NotCancelled();
    error ReleaseNotReady(uint256 executeAfter);
    error InsufficientVaultBalance(address token, uint256 requested, uint256 available);
    error InsufficientGasForPayout();
    error NothingOwed();
    error EtherTransferFailed();
    error TokenTransferFailed();
    error Reentrancy();
    error CctpDisabled();
    error CctpMisconfigured();
    error CctpBadMessage();
    error CctpNothingMinted();
    error CctpBurnFailed();
    error MaxFeeTooHigh();

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    /// @dev The lock lives in transient storage (EIP-1153) rather than a 1/2
    ///      storage sentinel: TLOAD/TSTORE cost 100 gas each against roughly
    ///      5,000 for a cold SLOAD plus a dirty SSTORE, and the slot is wiped
    ///      at the end of every transaction, so a lock can never be left set.
    ///      The target chains (Ethereum mainnet and Sepolia) have had Cancun
    ///      since March 2024; foundry.toml pins evm_version = cancun.
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
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner) revert NotGuardianOrOwner();
        _;
    }

    /// @param releaseDelay_ Taken here rather than set afterwards because an
    ///        owner that is a Safe cannot act inside the deployment.
    constructor(address owner_, address operator_, address guardian_, uint256 releaseDelay_) {
        if (owner_ == address(0) || operator_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (releaseDelay_ > MAX_RELEASE_DELAY) revert DelayTooLong();
        if (releaseDelay_ < MIN_RELEASE_DELAY) revert DelayTooShort();
        owner = owner_;
        operator = operator_;
        guardian = guardian_;
        // forge-lint: disable-next-line(unsafe-typecast) -- at most MAX_RELEASE_DELAY
        releaseDelay = uint64(releaseDelay_);
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorChanged(address(0), operator_);
        emit GuardianChanged(address(0), guardian_);
        emit ReleaseDelaySet(0, releaseDelay_);
    }

    // ------------------------------------------------------------------
    // Deposits (Ethereum -> Sequentia)
    // ------------------------------------------------------------------

    /// @notice Deposit ether to be bridged to `sequentiaAddress`.
    function depositEther(string calldata sequentiaAddress) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (msg.value == 0) revert ZeroAmount();
        _checkSequentiaAddress(bytes(sequentiaAddress).length);
        DepositRules memory rules = depositRules[address(0)];
        if (rules.blocked) revert TokenIsBlocked();
        _checkDepositLimits(rules, msg.value, address(this).balance);
        emit Deposited(depositCount++, address(0), msg.sender, msg.value, sequentiaAddress);
    }

    /// @notice Deposit `amount` of `token` to be bridged to `sequentiaAddress`.
    /// @dev Credits the balance actually received, so fee-on-transfer tokens
    ///      bridge the post-fee amount. The minimum applies to that credited
    ///      amount and the cap to the vault's balance after the deposit.
    function depositToken(address token, uint256 amount, string calldata sequentiaAddress) external nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _checkSequentiaAddress(bytes(sequentiaAddress).length);
        DepositRules memory rules = depositRules[token];
        if (rules.blocked) revert TokenIsBlocked();

        uint256 before = _balanceOf(token);
        if (!_callToken(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount), gasleft())) {
            revert TokenTransferFailed();
        }
        uint256 balanceAfter = _balanceOf(token);
        uint256 credited = balanceAfter - before;
        if (credited == 0) revert ZeroAmount();
        _checkDepositLimits(rules, credited, balanceAfter);

        emit Deposited(depositCount++, token, msg.sender, credited, sequentiaAddress);
    }

    // ------------------------------------------------------------------
    // CCTP inbound (USDC from another chain)
    // ------------------------------------------------------------------

    /// @notice Complete a CCTP V2 transfer of USDC to this vault. Anyone may
    ///         relay it.
    ///
    /// The burn on the source chain names this vault as mintRecipient and, so
    /// that only this function can complete it, as destinationCaller. (A burn
    /// that leaves destinationCaller empty can also be relayed straight to
    /// Circle's transmitter, bypassing this function: the USDC then arrives
    /// with no event here, as an unaccounted donation.) Its hookData says what
    /// the dollars are for:
    /// - CCTP_DEPOSIT_TAG followed by a Sequentia address (14 to 120 bytes): a
    ///   deposit. Emits Deposited (from = address(0)) and CctpDeposit with the
    ///   same nonce. Reverts while deposits are paused; the message stays
    ///   valid and can be relayed again after unpausing.
    /// - exactly CCTP_REBALANCE_TAG: liquidity from another escrow. Emits
    ///   RebalancedIn and creates no deposit.
    /// - anything else: the mint is still completed, because with this vault
    ///   as destinationCaller nothing else could ever complete it, and
    ///   CctpUnrecognized reports it for refunding.
    /// A burn that mints to someone other than this vault is relayed for the
    /// same reason, credits nothing and emits CctpForwarded; it reverts if the
    /// vault's USDC balance would change.
    /// The credited amount is the USDC balance change across the mint, never
    /// the message's own figures. Deposit minimums, caps and token blocking do
    /// not apply here: the dollars are already minted, and the daemon refunds
    /// what it cannot bridge.
    function receiveCctp(bytes calldata message, bytes calldata attestation) external nonReentrant {
        address transmitter = cctpMessageTransmitter;
        address usdc = cctpUsdc;
        if (transmitter == address(0)) revert CctpDisabled();
        if (message.length < BURN_HOOK) revert CctpBadMessage();
        // The message must be addressed to the local TokenMessenger, so its
        // body is a burn message the messenger validates. The vault never
        // relays anything else in its own name.
        if (bytes32(message[76:108]) != bytes32(uint256(uint160(cctpTokenMessenger)))) revert CctpBadMessage();
        // mintRecipient is read the way Circle reads it: its low 160 bits.
        if (address(uint160(uint256(bytes32(message[MSG_BODY + 36:MSG_BODY + 68])))) != address(this)) {
            _forwardCctp(message, attestation, transmitter, usdc);
            return;
        }

        uint8 kind = _cctpKind(message[BURN_HOOK:]);
        if (kind == CCTP_DEPOSIT && depositsPaused) revert DepositsArePaused();

        uint256 before = _balanceOf(usdc);
        if (!ICctpMessageTransmitterV2(transmitter).receiveMessage(message, attestation)) revert CctpBadMessage();
        uint256 credited = _balanceOf(usdc) - before;
        if (credited == 0) revert CctpNothingMinted();
        _recordCctpArrival(message, usdc, credited, kind);
    }

    /// @dev A burn that names this vault as destinationCaller but mints to
    ///      someone else can only be completed here, so it is relayed rather
    ///      than stranded. Nothing is credited, and the vault's USDC balance
    ///      must not move across it.
    function _forwardCctp(bytes calldata message, bytes calldata attestation, address transmitter, address usdc)
        private
    {
        uint256 before = _balanceOf(usdc);
        if (!ICctpMessageTransmitterV2(transmitter).receiveMessage(message, attestation)) revert CctpBadMessage();
        if (_balanceOf(usdc) != before) revert CctpBadMessage();
        emit CctpForwarded(
            uint32(bytes4(message[4:8])), bytes32(message[MSG_BODY + 36:MSG_BODY + 68]), bytes32(message[12:44])
        );
    }

    uint8 private constant CCTP_DEPOSIT = 0;
    uint8 private constant CCTP_REBALANCE = 1;
    uint8 private constant CCTP_UNRECOGNIZED = 2;

    function _cctpKind(bytes calldata hook) private pure returns (uint8) {
        uint256 tagLen = CCTP_DEPOSIT_TAG.length;
        if (hook.length >= tagLen && keccak256(hook[:tagLen]) == keccak256(CCTP_DEPOSIT_TAG)) {
            uint256 len = hook.length - tagLen;
            return len >= 14 && len <= 120 ? CCTP_DEPOSIT : CCTP_UNRECOGNIZED;
        }
        return keccak256(hook) == keccak256(CCTP_REBALANCE_TAG) ? CCTP_REBALANCE : CCTP_UNRECOGNIZED;
    }

    function _recordCctpArrival(bytes calldata message, address usdc, uint256 credited, uint8 kind) private {
        uint32 sourceDomain = uint32(bytes4(message[4:8]));
        bytes32 sender = bytes32(message[MSG_BODY + 100:MSG_BODY + 132]);
        if (kind == CCTP_DEPOSIT) {
            uint256 nonce = depositCount++;
            emit Deposited(nonce, usdc, address(0), credited, string(message[BURN_HOOK + CCTP_DEPOSIT_TAG.length:]));
            emit CctpDeposit(nonce, sourceDomain, sender, bytes32(message[12:44]), credited);
        } else if (kind == CCTP_REBALANCE) {
            emit RebalancedIn(usdc, credited, sourceDomain, sender);
        } else {
            emit CctpUnrecognized(sourceDomain, sender, bytes32(message[12:44]), credited, message[BURN_HOOK:]);
        }
    }

    // ------------------------------------------------------------------
    // Releases and refunds (Sequentia -> Ethereum), operator only
    // ------------------------------------------------------------------

    /// @notice Pay out `amount` of `token` (address(0) for ether) to `to`
    ///         against a Sequentia redemption identified by `redemptionId`.
    ///
    /// Within the token's rate limit the payout happens now: Released if the
    /// recipient accepted it, ReleaseDeferred (amount now owed to `to`) if it
    /// did not. Beyond the limit it is queued: ReleaseQueued, executable by
    /// anyone after `releaseDelay`. Either way the id is marked processed.
    /// Reverts with InsufficientVaultBalance if an immediate payout exceeds
    /// the vault's unreserved balance; nothing is recorded, so it can be
    /// retried.
    function release(address token, address payable to, uint256 amount, bytes32 redemptionId)
        external
        onlyOperator
        nonReentrant
    {
        _releaseOrQueue(token, to, amount, redemptionId, false);
    }

    /// @notice Pay a deposit back to its depositor when its Sequentia leg
    ///         cannot happen. Identical to release() - same id space, same
    ///         rate limit, same queue - except that a payment emits Refunded.
    function refund(address token, address payable to, uint256 amount, bytes32 refundId)
        external
        onlyOperator
        nonReentrant
    {
        _releaseOrQueue(token, to, amount, refundId, true);
    }

    /// @notice Pay a redemption out as USDC on another chain: burn `amount`
    ///         here through CCTP for minting to `mintRecipient` on
    ///         `destinationDomain`, less a fee of at most `maxFee`.
    ///
    /// Same id space, USDC rate limit, queue, pause and unreserved-balance
    /// rules as release(). Emits ReleasedViaCctp when burned now, ReleaseQueued
    /// (to = address(0)) when queued. Unlike a direct release it never defers:
    /// a failing burn reverts, because the recipient is not on this chain and
    /// cannot be the cause.
    function releaseViaCctp(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 redemptionId,
        uint256 maxFee
    ) external onlyOperator nonReentrant {
        _cctpReleaseOrQueue(amount, destinationDomain, mintRecipient, redemptionId, maxFee, false);
    }

    /// @notice refund() over CCTP: returns a CCTP deposit to its source chain.
    ///         A burn emits RefundedViaCctp.
    function refundViaCctp(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 refundId,
        uint256 maxFee
    ) external onlyOperator nonReentrant {
        _cctpReleaseOrQueue(amount, destinationDomain, mintRecipient, refundId, maxFee, true);
    }

    /// @notice Execute a queued release or refund once its delay has passed.
    ///         Callable by anyone. A direct payout emits Released or Refunded
    ///         if the recipient accepted the funds, ReleaseDeferred if it did
    ///         not; a CCTP one emits ReleasedViaCctp or RefundedViaCctp.
    function executeRelease(bytes32 redemptionId) external nonReentrant {
        QueuedRelease storage q = _queue[redemptionId];
        if (q.state != ReleaseState.Queued) revert NotQueued();
        if (releasesPaused) revert ReleasesArePaused();
        // forge-lint: disable-next-line(block-timestamp) -- a timelock measured in hours or days
        if (block.timestamp < q.executeAfter) revert ReleaseNotReady(q.executeAfter);

        address token = q.token;
        uint256 amount = q.amount;
        if (q.viaCctp && token != cctpUsdc) revert CctpDisabled();
        // This release is leaving the queue, so its own amount is not held
        // back from it.
        _requireUnreserved(token, amount, amount);
        q.state = ReleaseState.Executed;
        queuedTotal[token] -= amount;
        if (q.viaCctp) {
            _burnViaCctp(amount, q.destinationDomain, q.mintRecipient, redemptionId, q.maxFee, q.isRefund);
        } else {
            _payOut(token, q.to, amount, redemptionId, q.isRefund);
        }
    }

    /// @notice Stop a queued release. Its id stays processed; only the owner
    ///         can put it back in the queue.
    function cancelRelease(bytes32 redemptionId) external onlyGuardianOrOwner {
        QueuedRelease storage q = _queue[redemptionId];
        if (q.state != ReleaseState.Queued) revert NotQueued();
        q.state = ReleaseState.Cancelled;
        queuedTotal[q.token] -= q.amount;
        cancelledTotal[q.token] += q.amount;
        emit ReleaseCancelled(redemptionId, msg.sender);
    }

    /// @notice Return a cancelled release to the queue with a fresh delay.
    function reinstateRelease(bytes32 redemptionId) external onlyOwner {
        QueuedRelease storage q = _queue[redemptionId];
        if (q.state != ReleaseState.Cancelled) revert NotCancelled();
        uint64 executeAfter = uint64(block.timestamp) + releaseDelay;
        q.state = ReleaseState.Queued;
        q.executeAfter = executeAfter;
        cancelledTotal[q.token] -= q.amount;
        queuedTotal[q.token] += q.amount;
        emit ReleaseReinstated(redemptionId, executeAfter);
    }

    /// @notice Change where a cancelled release pays out, for one whose
    ///         destination stopped working (a CCTP domain or recipient that
    ///         fails, a recipient that should be paid on another chain). The
    ///         token, amount and release/refund kind stay as they were; the
    ///         owner then reinstates it, which restarts its delay.
    function amendCancelledRelease(
        bytes32 redemptionId,
        bool viaCctp,
        address to,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee
    ) external onlyOwner {
        QueuedRelease storage q = _queue[redemptionId];
        if (q.state != ReleaseState.Cancelled) revert NotCancelled();
        if (viaCctp) {
            if (q.token != cctpUsdc || q.token == address(0)) revert CctpDisabled();
            if (mintRecipient == bytes32(0)) revert InvalidRecipient();
            if (maxFee >= q.amount) revert MaxFeeTooHigh();
            to = address(0);
        } else {
            if (to == address(0) || to == address(this)) revert InvalidRecipient();
            destinationDomain = 0;
            mintRecipient = bytes32(0);
            maxFee = 0;
        }
        q.viaCctp = viaCctp;
        q.to = to;
        q.destinationDomain = destinationDomain;
        q.mintRecipient = mintRecipient;
        q.maxFee = maxFee;
        emit ReleaseAmended(redemptionId, viaCctp, to, destinationDomain, mintRecipient, maxFee);
    }

    /// @notice Drop a cancelled release for good, releasing its reservation.
    ///         Its id stays processed, so it can never be paid. This is how
    ///         the owner clears a bogus entry queued with a compromised
    ///         operator key after the guardian cancels it.
    function discardCancelledRelease(bytes32 redemptionId) external onlyOwner {
        QueuedRelease storage q = _queue[redemptionId];
        if (q.state != ReleaseState.Cancelled) revert NotCancelled();
        q.state = ReleaseState.Discarded;
        cancelledTotal[q.token] -= q.amount;
        emit ReleaseDiscarded(redemptionId);
    }

    /// @notice Withdraw everything owed to the caller in `token` to `payTo`.
    /// @dev Not stopped by the release pause: owed funds were already paid out
    ///      as far as the bridge is concerned, and are excluded from both the
    ///      releasable balance and a stablecoin burn. Reverts if the transfer
    ///      fails, so the caller can retry with another address. Only the owed
    ///      account can claim: a contract that can neither accept the payout
    ///      nor make calls can never collect it.
    function claim(address token, address payable payTo) external nonReentrant {
        if (payTo == address(0) || payTo == address(this)) revert InvalidRecipient();
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[token][msg.sender] = 0;
        owedTotal[token] -= amount;
        _transferOrRevert(token, payTo, amount);
        emit Claimed(token, msg.sender, payTo, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice A queued (or cancelled, or executed) release. State None means
    ///         the id was never queued: if processedRedemptions(id) is true it
    ///         settled immediately. `to` is address(0) for a CCTP release; see
    ///         queuedCctpRelease for its destination.
    function queuedRelease(bytes32 redemptionId)
        external
        view
        returns (address token, address to, uint256 amount, uint256 executeAfter, ReleaseState state, bool isRefund)
    {
        QueuedRelease storage q = _queue[redemptionId];
        return (q.token, q.to, q.amount, q.executeAfter, q.state, q.isRefund);
    }

    /// @notice The CCTP destination of a queued release; viaCctp is false for
    ///         a direct one.
    function queuedCctpRelease(bytes32 redemptionId)
        external
        view
        returns (bool viaCctp, uint32 destinationDomain, bytes32 mintRecipient, uint256 maxFee)
    {
        QueuedRelease storage q = _queue[redemptionId];
        return (q.viaCctp, q.destinationDomain, q.mintRecipient, q.maxFee);
    }

    /// @notice How much of `token` the operator can pay out right now without
    ///         queueing.
    function availableToRelease(address token) external view returns (uint256) {
        return _bucketLevel(releaseBuckets[token]);
    }

    /// @notice The vault's balance of `token` minus everything committed to
    ///         individual users: owed to claimants, queued, and cancelled but
    ///         reinstatable. The most an immediate payout or a rebalance can
    ///         take.
    function unreservedBalance(address token) external view returns (uint256) {
        uint256 balance = token == address(0) ? address(this).balance : _balanceOf(token);
        uint256 reserved = _reserved(token);
        return balance > reserved ? balance - reserved : 0;
    }

    function minDeposit(address token) external view returns (uint256) {
        return depositRules[token].minDeposit;
    }

    function depositCap(address token) external view returns (uint256) {
        return depositRules[token].cap;
    }

    function tokenBlocked(address token) external view returns (bool) {
        return depositRules[token].blocked;
    }

    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Start a two-step ownership transfer. address(0) cancels a
    ///         pending one.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    // ------------------------------------------------------------------
    // Limits and configuration
    // ------------------------------------------------------------------

    function setReleaseDelay(uint256 newDelay) external onlyOwner {
        if (newDelay > MAX_RELEASE_DELAY) revert DelayTooLong();
        if (newDelay < MIN_RELEASE_DELAY) revert DelayTooShort();
        emit ReleaseDelaySet(releaseDelay, newDelay);
        // forge-lint: disable-next-line(unsafe-typecast) -- at most MAX_RELEASE_DELAY
        releaseDelay = uint64(newDelay);
    }

    /// @notice Configure `token`'s release bucket. address(0) is ether.
    /// @dev Reconfiguring never tops the bucket up: its current level carries
    ///      over, clamped to the new capacity, so an owner slowing the refill
    ///      during an incident cannot accidentally hand out a fresh burst. A
    ///      newly configured bucket therefore starts empty and fills at
    ///      `refillPerSecond`.
    function setReleaseLimit(address token, uint256 capacity, uint256 refillPerSecond) external onlyOwner {
        if (capacity > type(uint128).max || refillPerSecond > type(uint128).max) revert ValueTooLarge();
        Bucket storage b = releaseBuckets[token];
        uint256 level = _bucketLevel(b);
        emit ReleaseLimitSet(token, b.capacity, b.refillPerSecond, capacity, refillPerSecond);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
        b.capacity = uint128(capacity);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
        b.refillPerSecond = uint128(refillPerSecond);
        b.available = uint128(level < capacity ? level : capacity);
        b.updatedAt = uint64(block.timestamp);
    }

    /// @notice Smallest credited amount a direct deposit of `token` may have.
    function setMinDeposit(address token, uint256 newMin) external onlyOwner {
        if (newMin > type(uint128).max) revert ValueTooLarge();
        DepositRules storage r = depositRules[token];
        emit MinDepositSet(token, r.minDeposit, newMin);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
        r.minDeposit = uint128(newMin);
    }

    /// @notice Largest balance of `token` the vault may hold after a direct
    ///         deposit. 0 means no cap.
    function setDepositCap(address token, uint256 newCap) external onlyOwner {
        if (newCap > type(uint120).max) revert ValueTooLarge();
        DepositRules storage r = depositRules[token];
        emit DepositCapSet(token, r.cap, newCap);
        // forge-lint: disable-next-line(unsafe-typecast) -- bounded above
        r.cap = uint120(newCap);
    }

    /// @notice Refuse (or accept again) direct deposits of `token`. Releases
    ///         of a blocked token are unaffected.
    function setTokenBlocked(address token, bool blocked) external onlyOwner {
        DepositRules storage r = depositRules[token];
        emit TokenBlockedSet(token, r.blocked, blocked);
        r.blocked = blocked;
    }

    /// @notice Point the vault at Circle's CCTP V2 on this chain. All three
    ///         zero disables CCTP; otherwise all three are required and the
    ///         messenger must name the transmitter as its own.
    function setCctp(address tokenMessenger, address messageTransmitter, address usdc) external onlyOwner {
        bool allZero = tokenMessenger == address(0) && messageTransmitter == address(0) && usdc == address(0);
        if (!allZero) {
            if (tokenMessenger == address(0) || messageTransmitter == address(0) || usdc == address(0)) {
                revert CctpMisconfigured();
            }
            if (ICctpTokenMessengerV2(tokenMessenger).localMessageTransmitter() != messageTransmitter) {
                revert CctpMisconfigured();
            }
        }
        emit CctpSet(cctpTokenMessenger, cctpMessageTransmitter, cctpUsdc, tokenMessenger, messageTransmitter, usdc);
        cctpTokenMessenger = tokenMessenger;
        cctpMessageTransmitter = messageTransmitter;
        cctpUsdc = usdc;
    }

    // ------------------------------------------------------------------
    // Pauses: guardian or owner stops, only the owner resumes
    // ------------------------------------------------------------------

    /// @notice Stop new deposits (existing funds stay releasable), e.g. while
    ///         migrating to a new vault or during an incident.
    function pauseDeposits() external onlyGuardianOrOwner {
        emit DepositsPausedSet(msg.sender, depositsPaused, true);
        depositsPaused = true;
    }

    function unpauseDeposits() external onlyOwner {
        emit DepositsPausedSet(msg.sender, depositsPaused, false);
        depositsPaused = false;
    }

    /// @notice Stop releases, refunds, queued executions and rebalancing.
    ///         Together with paused deposits this locks the supply for
    ///         reconciliation. Deliberately separate from pauseDeposits:
    ///         pausing deposits alone is routine and leaves users able to exit,
    ///         while stopping releases strands funds and belongs to an
    ///         incident or a planned, coordinated hand-off.
    function pauseReleases() external onlyGuardianOrOwner {
        emit ReleasesPausedSet(msg.sender, releasesPaused, true);
        releasesPaused = true;
    }

    function unpauseReleases() external onlyOwner {
        emit ReleasesPausedSet(msg.sender, releasesPaused, false);
        releasesPaused = false;
    }

    // ------------------------------------------------------------------
    // Stablecoin hand-off
    // ------------------------------------------------------------------

    /// @notice Name the stablecoin whose escrow may be burned, and the single
    ///         address permitted to burn it. The issuer supplies that address
    ///         near the hand-off; until it is set, nothing here can burn
    ///         anything.
    function setStablecoinBurner(address token, address burner) external onlyOwner {
        emit StablecoinBurnerSet(token, burner, lockedStablecoin, stablecoinBurner);
        lockedStablecoin = token;
        stablecoinBurner = burner;
    }

    /// @notice Burn the escrowed balance of the designated stablecoin.
    ///
    /// This is the issuer's step in a bridged-to-native hand-off: the bridged
    /// asset on Sequentia stops being backed by tokens held here and becomes a
    /// direct liability of the issuer instead. It burns the whole balance
    /// except what is already committed to individual users whose Sequentia
    /// side is settled - amounts owed to claimants (owedTotal), releases
    /// waiting in the queue (queuedTotal) and cancelled releases the owner may
    /// still reinstate (cancelledTotal) - rather than an amount passed in,
    /// because the supply lock has already made that remainder equal to the
    /// circulating supply on Sequentia; letting a caller name an amount would
    /// just add a way to get it wrong. The committed amounts stay here and are
    /// still paid out.
    ///
    /// Requires the supply to be locked, so the equality being relied on
    /// cannot change under the burn. Burning uses the token's own burn
    /// function, which for a fiat-backed stablecoin the issuer authorizes this
    /// vault to call as part of the hand-off. A cancelled release stays
    /// reserved until the owner reinstates or discards it, so a guardian
    /// cancel can never make a user's escrow burnable.
    function burnLockedUSDC() external nonReentrant {
        if (msg.sender != stablecoinBurner) revert NotBurner();
        address token = lockedStablecoin;
        if (token == address(0)) revert NoStablecoinConfigured();
        if (!depositsPaused || !releasesPaused) revert SupplyNotLocked();

        uint256 balance = _balanceOf(token);
        uint256 reserved = _reserved(token);
        if (balance <= reserved) revert ZeroAmount();
        uint256 amount = balance - reserved;
        (bool ok,) = token.call(abi.encodeWithSignature("burn(uint256)", amount));
        if (!ok) revert BurnFailed();
        if (_balanceOf(token) != reserved) revert BurnFailed();
        emit LockedStablecoinBurned(token, amount);
    }

    // ------------------------------------------------------------------
    // Rebalancing
    // ------------------------------------------------------------------

    /// @notice Move escrow off this chain so another chain's escrow can cover
    ///         redemptions there.
    ///
    /// A unified asset can be redeemed on a different chain than it was
    /// deposited on, so one escrow can run short while total backing is
    /// perfectly sound. This is how the owner refills it. It emits its own
    /// event rather than reusing Released, so that an auditor reconciling the
    /// escrow can always tell liquidity movements from user redemptions;
    /// `destination` records where the value went. It cannot touch amounts
    /// committed to users (owed, queued or cancelled-but-reinstatable), and it
    /// is stopped by the release pause so a locked supply stays locked.
    function rebalanceOut(address token, address payable to, uint256 amount, string calldata destination)
        external
        onlyOwner
        nonReentrant
    {
        if (releasesPaused) revert ReleasesArePaused();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        _requireUnreserved(token, amount, 0);
        _transferOrRevert(token, to, amount);
        emit Rebalanced(token, to, amount, destination);
    }

    /// @notice Add ether escrow without creating a deposit: the counterpart of
    ///         rebalanceOut for ether, which has no other way in. Emits
    ///         RebalancedIn with sourceDomain FUNDING_DOMAIN and the funder as
    ///         sender. The vault deliberately has no receive(), so ether sent
    ///         to it any other way is refused.
    function fundEther() external payable onlyOwner nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        emit RebalancedIn(address(0), msg.value, FUNDING_DOMAIN, bytes32(uint256(uint160(msg.sender))));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _releaseOrQueue(address token, address to, uint256 amount, bytes32 id, bool isRefund) private {
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (_admit(token, amount, id)) {
            _payOut(token, to, amount, id, isRefund);
        } else {
            _enqueue(token, to, amount, id, isRefund);
        }
    }

    function _cctpReleaseOrQueue(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 id,
        uint256 maxFee,
        bool isRefund
    ) private {
        address usdc = cctpUsdc;
        if (usdc == address(0)) revert CctpDisabled();
        if (mintRecipient == bytes32(0)) revert InvalidRecipient();
        if (amount != 0 && maxFee >= amount) revert MaxFeeTooHigh();
        if (_admit(usdc, amount, id)) {
            _burnViaCctp(amount, destinationDomain, mintRecipient, id, maxFee, isRefund);
        } else {
            QueuedRelease storage q = _enqueue(usdc, address(0), amount, id, isRefund);
            q.viaCctp = true;
            q.destinationDomain = destinationDomain;
            q.mintRecipient = mintRecipient;
            q.maxFee = maxFee;
        }
    }

    /// @dev Checks shared by every release and refund, plus the replay mark.
    ///      Returns true when the amount fits the token's bucket - which is
    ///      then debited, after checking the vault can cover it now - and
    ///      false when it must be queued.
    function _admit(address token, uint256 amount, bytes32 id) private returns (bool payNow) {
        if (releasesPaused) revert ReleasesArePaused();
        if (amount == 0) revert ZeroAmount();
        if (processedRedemptions[id]) revert AlreadyReleased();
        processedRedemptions[id] = true;

        Bucket storage b = releaseBuckets[token];
        uint256 level = _bucketLevel(b);
        if (amount > level) return false;
        _requireUnreserved(token, amount, 0);
        // forge-lint: disable-next-line(unsafe-typecast) -- level <= capacity, a uint128
        b.available = uint128(level - amount);
        b.updatedAt = uint64(block.timestamp);
        return true;
    }

    function _enqueue(address token, address to, uint256 amount, bytes32 id, bool isRefund)
        private
        returns (QueuedRelease storage q)
    {
        uint64 executeAfter = uint64(block.timestamp) + releaseDelay;
        q = _queue[id];
        q.token = token;
        q.executeAfter = executeAfter;
        q.state = ReleaseState.Queued;
        q.isRefund = isRefund;
        q.to = to;
        q.amount = amount;
        queuedTotal[token] += amount;
        emit ReleaseQueued(id, token, to, amount, executeAfter);
    }

    /// @dev Attempt the payout; if the recipient or token refuses it, record
    ///      it as owed instead of reverting. Called only after every state
    ///      change of the payout, under the reentrancy lock.
    function _payOut(address token, address to, uint256 amount, bytes32 id, bool isRefund) private {
        if (gasleft() < PAYOUT_GAS_FLOOR) revert InsufficientGasForPayout();
        bool ok;
        if (token == address(0)) {
            // No return data is copied, so a recipient cannot make the vault
            // pay for a huge return buffer.
            assembly ("memory-safe") {
                ok := call(PAYOUT_GAS, to, amount, 0, 0, 0, 0)
            }
        } else {
            ok = _callToken(token, abi.encodeWithSelector(0xa9059cbb, to, amount), PAYOUT_GAS);
        }

        if (ok) {
            if (isRefund) emit Refunded(token, to, amount, id);
            else emit Released(id, token, to, amount);
        } else {
            owed[token][to] += amount;
            owedTotal[token] += amount;
            emit ReleaseDeferred(id, token, to, amount);
        }
    }

    /// @dev Burn `amount` USDC through the TokenMessenger. The approval is for
    ///      exactly `amount` and is reset afterwards, and the vault's balance
    ///      must fall by exactly `amount`.
    function _burnViaCctp(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 id,
        uint256 maxFee,
        bool isRefund
    ) private {
        address messenger = cctpTokenMessenger;
        address usdc = cctpUsdc;
        uint256 before = _balanceOf(usdc);
        if (!_callToken(usdc, abi.encodeWithSelector(0x095ea7b3, messenger, amount), gasleft())) {
            revert TokenTransferFailed();
        }
        ICctpTokenMessengerV2(messenger)
            .depositForBurn(amount, destinationDomain, mintRecipient, usdc, bytes32(0), maxFee, CCTP_FINALITY_FINALIZED);
        if (!_callToken(usdc, abi.encodeWithSelector(0x095ea7b3, messenger, 0), gasleft())) {
            revert TokenTransferFailed();
        }
        if (before - _balanceOf(usdc) != amount) revert CctpBurnFailed();

        if (isRefund) emit RefundedViaCctp(id, destinationDomain, mintRecipient, amount);
        else emit ReleasedViaCctp(id, destinationDomain, mintRecipient, amount);
    }

    function _transferOrRevert(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            bool ok;
            assembly ("memory-safe") {
                ok := call(gas(), to, amount, 0, 0, 0, 0)
            }
            if (!ok) revert EtherTransferFailed();
        } else if (!_callToken(token, abi.encodeWithSelector(0xa9059cbb, to, amount), gasleft())) {
            revert TokenTransferFailed();
        }
    }

    /// @dev ERC-20 call that tolerates tokens returning no value (e.g. USDT).
    ///      Success means the call did not revert and either returned true or
    ///      returned nothing from an address that has code; the code-size
    ///      check is paid only in the no-data case. At most 32 bytes of return
    ///      data are copied.
    function _callToken(address token, bytes memory data, uint256 gasLimit) private returns (bool ok) {
        uint256 returnSize;
        uint256 returnWord;
        assembly ("memory-safe") {
            ok := call(gasLimit, token, 0, add(data, 0x20), mload(data), 0, 0x20)
            returnSize := returndatasize()
            returnWord := mload(0)
        }
        if (ok) ok = returnSize == 0 ? token.code.length != 0 : (returnSize >= 32 && returnWord == 1);
    }

    /// @dev Everything committed to individual users whose Sequentia side is
    ///      already settled: owed, queued, and cancelled (reinstatable).
    function _reserved(address token) private view returns (uint256) {
        return owedTotal[token] + queuedTotal[token] + cancelledTotal[token];
    }

    /// @dev Revert unless the balance, less what is reserved for others,
    ///      covers `amount`. `ownShare` is the part of the reservation that
    ///      belongs to this very payout (a queued release being executed).
    function _requireUnreserved(address token, uint256 amount, uint256 ownShare) private view {
        uint256 balance = token == address(0) ? address(this).balance : _balanceOf(token);
        uint256 reserved = _reserved(token) - ownShare;
        uint256 unreserved = balance > reserved ? balance - reserved : 0;
        if (amount > unreserved) revert InsufficientVaultBalance(token, amount, unreserved);
    }

    function _bucketLevel(Bucket storage b) private view returns (uint256) {
        uint256 level = uint256(b.available) + (block.timestamp - b.updatedAt) * b.refillPerSecond;
        return level < b.capacity ? level : b.capacity;
    }

    function _checkDepositLimits(DepositRules memory rules, uint256 credited, uint256 balanceAfter) private pure {
        if (credited < rules.minDeposit) revert BelowMinDeposit(rules.minDeposit);
        if (rules.cap != 0 && balanceAfter > rules.cap) revert DepositCapExceeded(rules.cap);
    }

    function _checkSequentiaAddress(uint256 len) private pure {
        // Real validation happens in the bridge daemon; this only rejects
        // obviously malformed values so mistakes fail fast and cheap.
        if (len < 14 || len > 120) revert BadSequentiaAddress();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || data.length < 32) revert TokenTransferFailed();
        return abi.decode(data, (uint256));
    }
}
