// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CompagesVault - Ethereum-side vault of Compages, the Sequentia bridge
/// @notice Ethereum-side vault of the centralized Sequentia bridge.
///
/// Users deposit ether or any ERC-20 together with the Sequentia address that
/// should receive the bridged asset. The bridge operator watches Deposited
/// events, issues (first deposit of a token) or reissues (later deposits) the
/// corresponding Sequentia asset, and sends it to that address.
///
/// Redemptions burn the bridged asset on Sequentia; the operator then calls
/// release() to pay the locked ether/tokens out on Ethereum. Each release is
/// keyed by a redemption id derived from the Sequentia transaction so it can
/// never be paid twice.
///
/// Trust model: this is an explicitly centralized bridge. The operator can
/// move vault funds via release(); depositors trust the bridge operator.
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
contract CompagesVault {
    address public owner;
    address public operator;
    bool public depositsPaused;

    /// @notice Pausing releases as well as deposits is what makes a supply
    ///         lock real: with both directions stopped, the escrow here and the
    ///         circulating supply on Sequentia stop moving relative to each
    ///         other and can be reconciled exactly.
    bool public releasesPaused;

    /// @notice The stablecoin whose escrow may be burned at hand-off, and the
    ///         only address allowed to burn it. Both are set by the owner near
    ///         the hand-off rather than at deployment, because the issuer names
    ///         its burner address then.
    address public lockedStablecoin;
    address public stablecoinBurner;

    /// @notice Monotonic id assigned to every deposit, ether or token.
    uint256 public depositCount;

    /// @notice Redemption ids (derived from Sequentia redemption txids) that
    ///         have already been released, to prevent double payout.
    mapping(bytes32 => bool) public processedRedemptions;

    /// @dev token == address(0) means ether.
    event Deposited(
        uint256 indexed nonce,
        address indexed token,
        address indexed from,
        uint256 amount,
        string sequentiaAddress
    );
    event Released(
        bytes32 indexed redemptionId,
        address indexed token,
        address indexed to,
        uint256 amount
    );
    event OperatorChanged(address indexed operator);
    event OwnershipTransferred(address indexed owner);
    event DepositsPausedSet(bool paused);
    event ReleasesPausedSet(bool paused);
    event StablecoinBurnerSet(address indexed token, address indexed burner);
    event LockedStablecoinBurned(address indexed token, uint256 amount);
    /// @dev Distinct from Released so an observer can tell operator liquidity
    ///      movements apart from user redemptions when auditing the escrow.
    event Rebalanced(address indexed token, address indexed to, uint256 amount, string destination);

    error NotOwner();
    error NotOperator();
    error NotBurner();
    error DepositsArePaused();
    error ReleasesArePaused();
    error SupplyNotLocked();
    error NoStablecoinConfigured();
    error BurnFailed();
    error ZeroAmount();
    error ZeroAddress();
    error BadSequentiaAddress();
    error AlreadyReleased();
    error EtherTransferFailed();
    error TokenTransferFailed();
    error Reentrancy();

    uint256 private _entered;

    modifier nonReentrant() {
        if (_entered != 0) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(address _operator) {
        if (_operator == address(0)) revert ZeroAddress();
        owner = msg.sender;
        operator = _operator;
        emit OperatorChanged(_operator);
    }

    // ------------------------------------------------------------------
    // Deposits (Ethereum -> Sequentia)
    // ------------------------------------------------------------------

    /// @notice Deposit ether to be bridged to `sequentiaAddress`.
    function depositEther(string calldata sequentiaAddress) external payable nonReentrant {
        if (depositsPaused) revert DepositsArePaused();
        if (msg.value == 0) revert ZeroAmount();
        _checkSequentiaAddress(sequentiaAddress);
        emit Deposited(depositCount++, address(0), msg.sender, msg.value, sequentiaAddress);
    }

    /// @notice Deposit `amount` of `token` to be bridged to `sequentiaAddress`.
    /// @dev Credits the balance actually received, so fee-on-transfer tokens
    ///      bridge the post-fee amount.
    function depositToken(address token, uint256 amount, string calldata sequentiaAddress)
        external
        nonReentrant
    {
        if (depositsPaused) revert DepositsArePaused();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _checkSequentiaAddress(sequentiaAddress);

        uint256 before = _balanceOf(token, address(this));
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 credited = _balanceOf(token, address(this)) - before;
        if (credited == 0) revert ZeroAmount();

        emit Deposited(depositCount++, token, msg.sender, credited, sequentiaAddress);
    }

    // ------------------------------------------------------------------
    // Releases (Sequentia -> Ethereum), operator only
    // ------------------------------------------------------------------

    /// @notice Pay out `amount` of `token` (address(0) for ether) to `to`,
    ///         against a Sequentia redemption identified by `redemptionId`.
    ///         Also used to refund a deposit whose Sequentia leg failed, with
    ///         a redemption id derived from the deposit instead.
    function release(address token, address payable to, uint256 amount, bytes32 redemptionId)
        external
        onlyOperator
        nonReentrant
    {
        if (releasesPaused) revert ReleasesArePaused();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (processedRedemptions[redemptionId]) revert AlreadyReleased();
        processedRedemptions[redemptionId] = true;

        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EtherTransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
        emit Released(redemptionId, token, to, amount);
    }

    // ------------------------------------------------------------------
    // Administration
    // ------------------------------------------------------------------

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
        emit OperatorChanged(_operator);
    }

    function transferOwnership(address _owner) external onlyOwner {
        if (_owner == address(0)) revert ZeroAddress();
        owner = _owner;
        emit OwnershipTransferred(_owner);
    }

    /// @notice Pause new deposits (existing funds stay releasable), e.g. while
    ///         migrating to a new vault or during an incident.
    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    /// @notice Pause releases too, which together with paused deposits locks
    ///         the supply for reconciliation. Deliberately separate from
    ///         setDepositsPaused: pausing deposits alone is routine and leaves
    ///         users able to exit, while stopping releases strands funds and
    ///         is only appropriate for a planned, coordinated hand-off.
    function setReleasesPaused(bool paused) external onlyOwner {
        releasesPaused = paused;
        emit ReleasesPausedSet(paused);
    }

    // ------------------------------------------------------------------
    // Stablecoin hand-off
    // ------------------------------------------------------------------

    /// @notice Name the stablecoin whose escrow may be burned, and the single
    ///         address permitted to burn it. The issuer supplies that address
    ///         near the hand-off; until it is set, nothing here can burn
    ///         anything.
    function setStablecoinBurner(address token, address burner) external onlyOwner {
        lockedStablecoin = token;
        stablecoinBurner = burner;
        emit StablecoinBurnerSet(token, burner);
    }

    /// @notice Burn the entire escrowed balance of the designated stablecoin.
    ///
    /// This is the issuer's step in a bridged-to-native hand-off: the bridged
    /// asset on Sequentia stops being backed by tokens held here and becomes a
    /// direct liability of the issuer instead. It burns the whole balance
    /// rather than an amount passed in, because the supply lock has already
    /// made that balance equal to the circulating supply on Sequentia; letting
    /// a caller name an amount would just add a way to get it wrong.
    ///
    /// Requires the supply to be locked, so the equality being relied on
    /// cannot change under the burn. Burning uses the token's own burn
    /// function, which for a fiat-backed stablecoin the issuer authorizes this
    /// vault to call as part of the hand-off.
    function burnLockedUSDC() external nonReentrant {
        if (msg.sender != stablecoinBurner) revert NotBurner();
        address token = lockedStablecoin;
        if (token == address(0)) revert NoStablecoinConfigured();
        if (!depositsPaused || !releasesPaused) revert SupplyNotLocked();

        uint256 amount = _balanceOf(token, address(this));
        if (amount == 0) revert ZeroAmount();
        (bool ok,) = token.call(abi.encodeWithSignature("burn(uint256)", amount));
        if (!ok) revert BurnFailed();
        if (_balanceOf(token, address(this)) != 0) revert BurnFailed();
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
    /// perfectly sound. This is how the operator refills it. It emits its own
    /// event rather than reusing Released, so that an auditor reconciling the
    /// escrow can always tell operator liquidity movements from user
    /// redemptions; `destination` records where the value went.
    ///
    /// This grants the operator no power it did not already have, since
    /// release() can already pay any address.
    function rebalanceOut(address token, address payable to, uint256 amount, string calldata destination)
        external
        onlyOperator
        nonReentrant
    {
        if (releasesPaused) revert ReleasesArePaused();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EtherTransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
        emit Rebalanced(token, to, amount, destination);
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _checkSequentiaAddress(string calldata addr) private pure {
        // Real validation happens in the bridge daemon; this only rejects
        // obviously malformed values so mistakes fail fast and cheap.
        uint256 len = bytes(addr).length;
        if (len < 14 || len > 120) revert BadSequentiaAddress();
    }

    function _balanceOf(address token, address account) private view returns (uint256) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length < 32) revert TokenTransferFailed();
        return abi.decode(data, (uint256));
    }

    /// @dev Tolerates non-standard ERC-20s that return no value (e.g. USDT).
    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        _requireTransferOk(ok, data, token);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        _requireTransferOk(ok, data, token);
    }

    function _requireTransferOk(bool ok, bytes memory data, address token) private view {
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) || token.code.length == 0) {
            revert TokenTransferFailed();
        }
    }
}
