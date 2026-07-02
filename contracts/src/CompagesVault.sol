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
contract CompagesVault {
    address public owner;
    address public operator;
    bool public depositsPaused;

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

    error NotOwner();
    error NotOperator();
    error DepositsArePaused();
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
