// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CompagesVault} from "../src/CompagesVault.sol";
import {MockERC20, BlocklistPausableERC20} from "./mocks/MockTokens.sol";
import {RejectingReceiver} from "./mocks/MockReceivers.sol";
import {MockMessageTransmitterV2, MockTokenMessengerV2} from "./mocks/MockCctp.sol";

/// Drives the vault through random sequences of every fund-moving operation
/// and keeps an independent ledger built from the vault's own events.
contract VaultHandler is Test {
    CompagesVault public vault;
    MockERC20 public tok;
    BlocklistPausableERC20 public usdc;
    MockMessageTransmitterV2 public transmitter;
    MockTokenMessengerV2 public messenger;
    RejectingReceiver public rejecter;

    address public owner;
    address public operator;
    address public guardian;

    uint32 constant SOLANA = 5;
    bytes32 constant REMOTE_TM = bytes32(uint256(0xAAAA));
    bytes32 constant SOL_USDC = keccak256("sol-usdc");
    string constant SEQ_ADDR = "tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty";

    address[] public tokens;
    address[] public actors;
    bytes32[] public ids;

    // Ledger per token, from events: everything credited in, everything out.
    mapping(address => uint256) public creditedIn;
    mapping(address => uint256) public paidOut;
    uint256 public depositEvents;
    uint256 private seq;

    /// Set if an outflow ever left the vault holding less than what it has
    /// reserved for queued, cancelled and owed amounts, having started with
    /// enough.
    bool public reservationBreached;

    /// Set if relaying a CCTP mint for another recipient changed the vault's
    /// USDC balance.
    bool public forwardMovedFunds;

    constructor(
        CompagesVault v,
        MockERC20 t,
        BlocklistPausableERC20 u,
        MockMessageTransmitterV2 mt,
        MockTokenMessengerV2 tm,
        address owner_,
        address operator_,
        address guardian_
    ) {
        vault = v;
        tok = t;
        usdc = u;
        transmitter = mt;
        messenger = tm;
        owner = owner_;
        operator = operator_;
        guardian = guardian_;
        rejecter = new RejectingReceiver();
        tokens.push(address(0));
        tokens.push(address(t));
        tokens.push(address(u));
        actors.push(makeAddr("a1"));
        actors.push(makeAddr("a2"));
        actors.push(makeAddr("a3"));
        actors.push(address(rejecter));
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    // ------------------------------------------------------------------
    // ledger
    // ------------------------------------------------------------------

    function _begin() private {
        vm.recordLogs();
    }

    function _end() private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(vault)) continue;
            bytes32 t0 = l.topics[0];
            if (t0 == CompagesVault.Deposited.selector) {
                (uint256 amount,) = abi.decode(l.data, (uint256, string));
                creditedIn[_addr(l.topics[2])] += amount;
                depositEvents++;
            } else if (t0 == CompagesVault.RebalancedIn.selector) {
                creditedIn[_addr(l.topics[1])] += _word(l.data, 0);
            } else if (t0 == CompagesVault.CctpUnrecognized.selector) {
                creditedIn[address(usdc)] += _word(l.data, 2);
            } else if (t0 == CompagesVault.Released.selector) {
                paidOut[_addr(l.topics[2])] += _word(l.data, 0);
            } else if (
                t0 == CompagesVault.Refunded.selector || t0 == CompagesVault.Claimed.selector
                    || t0 == CompagesVault.Rebalanced.selector || t0 == CompagesVault.LockedStablecoinBurned.selector
            ) {
                paidOut[_addr(l.topics[1])] += _word(l.data, 0);
            } else if (t0 == CompagesVault.ReleasedViaCctp.selector || t0 == CompagesVault.RefundedViaCctp.selector) {
                paidOut[address(usdc)] += _word(l.data, 1);
            }
        }
    }

    function _addr(bytes32 topic) private pure returns (address) {
        return address(uint160(uint256(topic)));
    }

    function _word(bytes memory data, uint256 index) private pure returns (uint256 w) {
        assembly {
            w := mload(add(add(data, 0x20), mul(index, 0x20)))
        }
    }

    function _balance(address t) private view returns (uint256) {
        return t == address(0) ? address(vault).balance : MockERC20(t).balanceOf(address(vault));
    }

    function _reserved(address t) private view returns (uint256) {
        return vault.owedTotal(t) + vault.queuedTotal(t) + vault.cancelledTotal(t);
    }

    /// An outflow must never take the vault from covering its reservations
    /// to not covering them.
    function _checkReserve(address t, uint256 balanceBefore, bool coveredBefore) private {
        if (coveredBefore && _balance(t) < balanceBefore && _balance(t) < _reserved(t)) {
            reservationBreached = true;
        }
    }

    function _token(uint256 seed) private view returns (address) {
        return tokens[seed % tokens.length];
    }

    function _actor(uint256 seed) private view returns (address) {
        return actors[seed % actors.length];
    }

    function _eoa(uint256 seed) private view returns (address) {
        return actors[seed % (actors.length - 1)];
    }

    function _newId() private returns (bytes32 id) {
        id = keccak256(abi.encode("id", ++seq));
        ids.push(id);
    }

    // ------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------

    function depositEther(uint256 actorSeed, uint256 amount) external {
        amount = bound(amount, 1, 100 ether);
        address a = _eoa(actorSeed);
        vm.deal(a, amount);
        _begin();
        vm.prank(a);
        vault.depositEther{value: amount}(SEQ_ADDR);
        _end();
    }

    function depositToken(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        amount = bound(amount, 1, 1e15);
        MockERC20 t = tokenSeed % 2 == 0 ? tok : MockERC20(address(usdc));
        address a = _eoa(actorSeed);
        t.mint(a, amount);
        vm.prank(a);
        t.approve(address(vault), amount);
        _begin();
        vm.prank(a);
        vault.depositToken(address(t), amount, SEQ_ADDR);
        _end();
    }

    function _cctpMessage(uint256 amount, uint256 fee, bytes memory hook) private returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            uint32(1), SOL_USDC, bytes32(uint256(uint160(address(vault)))), amount, keccak256("sender")
        );
        body = abi.encodePacked(body, fee, fee, uint256(0), hook);
        return abi.encodePacked(
            uint32(1),
            SOLANA,
            uint32(0),
            keccak256(abi.encode("cctp", ++seq)),
            REMOTE_TM,
            bytes32(uint256(uint160(address(messenger)))),
            bytes32(uint256(uint160(address(vault)))),
            uint32(2000),
            uint32(2000),
            body
        );
    }

    function cctpDeposit(uint256 amount, uint256 fee) external {
        amount = bound(amount, 2, 1e15);
        fee = bound(fee, 0, amount / 10);
        bytes memory m = _cctpMessage(amount, fee, abi.encodePacked("compages:deposit:", SEQ_ADDR));
        _begin();
        vault.receiveCctp(m, "valid");
        _end();
    }

    function cctpRebalanceIn(uint256 amount) external {
        amount = bound(amount, 1, 1e15);
        bytes memory m = _cctpMessage(amount, 0, "compages:rebalance");
        _begin();
        vault.receiveCctp(m, "valid");
        _end();
    }

    function release(uint256 tokenSeed, uint256 actorSeed, uint256 amount, bool asRefund) external {
        address t = _token(tokenSeed);
        amount = bound(amount, 1, t == address(0) ? 50 ether : 5e14);
        bytes32 id = _newId();
        uint256 before = _balance(t);
        bool covered = before >= _reserved(t);
        _begin();
        vm.prank(operator);
        if (asRefund) vault.refund(t, payable(_actor(actorSeed)), amount, id);
        else vault.release(t, payable(_actor(actorSeed)), amount, id);
        _end();
        _checkReserve(t, before, covered);
    }

    function releaseViaCctp(uint256 amount, bool asRefund) external {
        amount = bound(amount, 1, 5e14);
        bytes32 id = _newId();
        uint256 before = _balance(address(usdc));
        bool covered = before >= _reserved(address(usdc));
        _begin();
        vm.prank(operator);
        if (asRefund) vault.refundViaCctp(amount, SOLANA, keccak256("r"), id, 0);
        else vault.releaseViaCctp(amount, SOLANA, keccak256("r"), id, 0);
        _end();
        _checkReserve(address(usdc), before, covered);
    }

    function executeRelease(uint256 idSeed, bool waitOut) external {
        if (ids.length == 0) return;
        if (waitOut) vm.warp(block.timestamp + vault.releaseDelay());
        bytes32 id = ids[idSeed % ids.length];
        (address t,,,,,) = vault.queuedRelease(id);
        uint256 before = _balance(t);
        bool covered = before >= _reserved(t);
        _begin();
        vault.executeRelease(id);
        _end();
        _checkReserve(t, before, covered);
    }

    function cancelRelease(uint256 idSeed) external {
        if (ids.length == 0) return;
        vm.prank(guardian);
        vault.cancelRelease(ids[idSeed % ids.length]);
    }

    function reinstateRelease(uint256 idSeed) external {
        if (ids.length == 0) return;
        vm.prank(owner);
        vault.reinstateRelease(ids[idSeed % ids.length]);
    }

    function claim(uint256 actorSeed, uint256 tokenSeed, uint256 payToSeed) external {
        address a = _actor(actorSeed);
        address t = _token(tokenSeed);
        address payTo = _eoa(payToSeed);
        _begin();
        if (a == address(rejecter)) {
            rejecter.claimFrom(vault, t, payable(payTo));
        } else {
            vm.prank(a);
            vault.claim(t, payable(payTo));
        }
        _end();
    }

    function rebalanceOut(uint256 tokenSeed, uint256 amount) external {
        address t = _token(tokenSeed);
        amount = bound(amount, 1, t == address(0) ? 50 ether : 5e14);
        uint256 before = _balance(t);
        bool covered = before >= _reserved(t);
        _begin();
        vm.prank(owner);
        vault.rebalanceOut(t, payable(makeAddr("other-chain")), amount, "elsewhere");
        _end();
        _checkReserve(t, before, covered);
    }

    /// A burn relayed through the vault to another recipient: the ledger must
    /// not move (no event credits it) and neither may the vault's balance.
    function cctpForwarded(uint256 amount, uint256 actorSeed) external {
        amount = bound(amount, 1, 1e15);
        address to = _eoa(actorSeed);
        bytes memory body =
            abi.encodePacked(uint32(1), SOL_USDC, bytes32(uint256(uint160(to))), amount, keccak256("sender"));
        body = abi.encodePacked(body, uint256(0), uint256(0), uint256(0), bytes("compages:deposit:short"));
        bytes memory m = abi.encodePacked(
            uint32(1),
            SOLANA,
            uint32(0),
            keccak256(abi.encode("fwd", ++seq)),
            REMOTE_TM,
            bytes32(uint256(uint160(address(messenger)))),
            bytes32(uint256(uint160(address(vault)))),
            uint32(2000),
            uint32(2000),
            body
        );
        uint256 before = usdc.balanceOf(address(vault));
        _begin();
        vault.receiveCctp(m, "valid");
        _end();
        if (usdc.balanceOf(address(vault)) != before) forwardMovedFunds = true;
    }

    function cctpUnrecognized(uint256 amount, uint256 hookSeed) external {
        amount = bound(amount, 1, 1e15);
        bytes memory hook = hookSeed % 3 == 0
            ? bytes("")
            : hookSeed % 3 == 1 ? bytes("compages:deposit:short") : abi.encodePacked("junk", hookSeed);
        bytes memory m = _cctpMessage(amount, 0, hook);
        _begin();
        vault.receiveCctp(m, "valid");
        _end();
    }

    function fundEther(uint256 amount) external {
        amount = bound(amount, 1, 100 ether);
        vm.deal(owner, amount);
        _begin();
        vm.prank(owner);
        vault.fundEther{value: amount}();
        _end();
    }

    function discardCancelledRelease(uint256 idSeed) external {
        if (ids.length == 0) return;
        vm.prank(owner);
        vault.discardCancelledRelease(ids[idSeed % ids.length]);
    }

    function amendCancelledRelease(uint256 idSeed, uint256 actorSeed, bool viaCctp) external {
        if (ids.length == 0) return;
        vm.prank(owner);
        vault.amendCancelledRelease(
            ids[idSeed % ids.length], viaCctp, _actor(actorSeed), SOLANA, keccak256("amended"), 0
        );
    }

    function setReleaseLimit(uint256 tokenSeed, uint256 capacity, uint256 refill) external {
        address t = _token(tokenSeed);
        capacity = bound(capacity, 0, t == address(0) ? 100 ether : 1e15);
        refill = bound(refill, 0, capacity);
        vm.prank(owner);
        vault.setReleaseLimit(t, capacity, refill);
    }

    function toggleBlocklist(uint256 actorSeed) external {
        address a = _eoa(actorSeed);
        usdc.setBlocklisted(a, !usdc.blocklisted(a));
    }

    function toggleReleasePause(bool pause) external {
        vm.prank(pause ? guardian : owner);
        if (pause) vault.pauseReleases();
        else vault.unpauseReleases();
    }

    function handOffBurn() external {
        vm.startPrank(owner);
        vault.pauseDeposits();
        vault.pauseReleases();
        vm.stopPrank();
        _begin();
        vm.prank(makeAddr("issuer"));
        vault.burnLockedUSDC();
        _end();
        vm.startPrank(owner);
        vault.unpauseDeposits();
        vault.unpauseReleases();
        vm.stopPrank();
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 0, 3 days));
    }
}

contract CompagesVaultInvariantTest is Test {
    CompagesVault vault;
    VaultHandler handler;
    MockERC20 tok;
    BlocklistPausableERC20 usdc;

    function setUp() public {
        address owner = makeAddr("owner");
        address operator = makeAddr("operator");
        address guardian = makeAddr("guardian");
        vault = new CompagesVault(owner, operator, guardian, 1 days);
        tok = new MockERC20("Mock USD", "MUSD", 6);
        usdc = new BlocklistPausableERC20();
        MockMessageTransmitterV2 mt = new MockMessageTransmitterV2(0);
        MockTokenMessengerV2 tm = new MockTokenMessengerV2(mt);
        tm.addRemote(5, bytes32(uint256(0xAAAA)), keccak256("sol-usdc"), address(usdc));

        vm.startPrank(owner);
        vault.setCctp(address(tm), address(mt), address(usdc));
        vault.setStablecoinBurner(address(usdc), makeAddr("issuer"));
        vault.setReleaseLimit(address(0), 20 ether, 0.01 ether);
        vault.setReleaseLimit(address(tok), 1e14, 1e10);
        vault.setReleaseLimit(address(usdc), 1e14, 1e10);
        vm.stopPrank();

        handler = new VaultHandler(vault, tok, usdc, mt, tm, owner, operator, guardian);
        targetContract(address(handler));
    }

    function _balance(address t) internal view returns (uint256) {
        return t == address(0) ? address(vault).balance : MockERC20(t).balanceOf(address(vault));
    }

    /// Every unit in the vault is accounted for by events: credited deposits
    /// and inbound liquidity, less payouts, claims, rebalances, CCTP burns and
    /// hand-off burns.
    function invariant_balanceMatchesLedger() public view {
        for (uint256 i; i < handler.tokenCount(); i++) {
            address t = handler.tokens(i);
            assertEq(_balance(t), handler.creditedIn(t) - handler.paidOut(t), "ledger");
        }
    }

    /// Everything committed to users - owed to claimants, queued, and
    /// cancelled but reinstatable - is always there: payouts, rebalances and
    /// burns spend only the rest, and nothing is queued beyond it.
    function invariant_balanceCoversAllReservations() public view {
        for (uint256 i; i < handler.tokenCount(); i++) {
            address t = handler.tokens(i);
            assertGe(_balance(t), vault.owedTotal(t) + vault.queuedTotal(t) + vault.cancelledTotal(t), "reservations");
        }
    }

    /// owedTotal is exactly the sum of individual owed balances.
    function invariant_owedTotalIsSumOfOwed() public view {
        for (uint256 i; i < handler.tokenCount(); i++) {
            address t = handler.tokens(i);
            uint256 sum;
            for (uint256 j; j < handler.actorCount(); j++) {
                sum += vault.owed(t, handler.actors(j));
            }
            assertEq(vault.owedTotal(t), sum, "owedTotal");
        }
    }

    /// queuedTotal and cancelledTotal are exactly the sums of releases in
    /// those states, and every id ever queued is marked processed.
    function invariant_queuedAndCancelledTotals() public view {
        uint256[3] memory queued;
        uint256[3] memory cancelled;
        for (uint256 k; k < handler.idCount(); k++) {
            bytes32 id = handler.ids(k);
            (address t,, uint256 amount,, CompagesVault.ReleaseState s,) = vault.queuedRelease(id);
            if (s != CompagesVault.ReleaseState.None) assertTrue(vault.processedRedemptions(id));
            for (uint256 i; i < 3; i++) {
                if (handler.tokens(i) != t) continue;
                if (s == CompagesVault.ReleaseState.Queued) queued[i] += amount;
                if (s == CompagesVault.ReleaseState.Cancelled) cancelled[i] += amount;
            }
        }
        for (uint256 i; i < 3; i++) {
            assertEq(vault.queuedTotal(handler.tokens(i)), queued[i], "queuedTotal");
            assertEq(vault.cancelledTotal(handler.tokens(i)), cancelled[i], "cancelledTotal");
        }
    }

    /// No payout, CCTP burn or rebalance ever spent funds reserved for
    /// queued, cancelled or owed amounts.
    function invariant_outflowsRespectReservations() public view {
        assertFalse(handler.reservationBreached());
    }

    /// Forwarding a CCTP mint to another recipient never moves vault funds.
    function invariant_forwardingNeverMovesVaultFunds() public view {
        assertFalse(handler.forwardMovedFunds());
    }

    function invariant_depositCountMatchesEvents() public view {
        assertEq(vault.depositCount(), handler.depositEvents());
    }

    function invariant_noLeftoverMessengerAllowance() public view {
        assertEq(usdc.allowance(address(vault), vault.cctpTokenMessenger()), 0);
    }
}
