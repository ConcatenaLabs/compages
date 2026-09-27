// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CompagesVault} from "../src/CompagesVault.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {
    MockERC20,
    FeeOnTransferERC20,
    NoReturnERC20,
    FalseReturnERC20,
    BlocklistPausableERC20,
    RebasingERC20
} from "./mocks/MockTokens.sol";
import {RejectingReceiver, GasBurner, ReentrantReceiver, PickyReceiver} from "./mocks/MockReceivers.sol";

contract CompagesVaultTest is Test {
    CompagesVault vault;
    MockERC20 token;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant DELAY = 1 days;
    address constant ETH = address(0);
    string constant SEQ_ADDR = "tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty";

    event Deposited(
        uint256 indexed nonce, address indexed token, address indexed from, uint256 amount, string sequentiaAddress
    );
    event Released(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount);
    event Refunded(address indexed token, address indexed to, uint256 amount, bytes32 indexed refundId);
    event ReleaseQueued(
        bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount, uint256 executeAfter
    );
    event ReleaseCancelled(bytes32 indexed redemptionId, address indexed by);
    event ReleaseReinstated(bytes32 indexed redemptionId, uint256 executeAfter);
    event ReleaseDeferred(bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount);
    event Claimed(address indexed token, address indexed account, address indexed payTo, uint256 amount);
    event Rebalanced(address indexed token, address indexed to, uint256 amount, string destination);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event ReleaseLimitSet(
        address indexed token,
        uint256 previousCapacity,
        uint256 previousRefillPerSecond,
        uint256 newCapacity,
        uint256 newRefillPerSecond
    );

    function setUp() public {
        vault = new CompagesVault(owner, operator, guardian, DELAY);
        token = new MockERC20("Mock USD", "MUSD", 6);
        token.mint(alice, 1_000_000e6);
        vm.deal(alice, 100 ether);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /// A bucket that is full and refills to full within a second.
    function _unlimit(address t) internal {
        vm.prank(owner);
        vault.setReleaseLimit(t, type(uint128).max, type(uint128).max);
        vm.warp(block.timestamp + 1);
    }

    function _fund() internal {
        vm.startPrank(alice);
        vault.depositEther{value: 10 ether}(SEQ_ADDR);
        token.approve(address(vault), 1000e6);
        vault.depositToken(address(token), 1000e6, SEQ_ADDR);
        vm.stopPrank();
    }

    function _escrow(uint256 amount) internal {
        vm.startPrank(alice);
        token.approve(address(vault), amount);
        vault.depositToken(address(token), amount, SEQ_ADDR);
        vm.stopPrank();
    }

    function _state(bytes32 id) internal view returns (CompagesVault.ReleaseState s) {
        (,,,, s,) = vault.queuedRelease(id);
    }

    function _lock() internal {
        vm.startPrank(owner);
        vault.pauseDeposits();
        vault.pauseReleases();
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // construction and version
    // ------------------------------------------------------------------

    function test_constructor_setsRoles() public view {
        assertEq(vault.VERSION(), 3);
        assertEq(vault.owner(), owner);
        assertEq(vault.operator(), operator);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.releaseDelay(), DELAY);
        assertEq(vault.pendingOwner(), address(0));
    }

    function test_constructor_rejectsZeroAddressesAndBadDelay() public {
        vm.expectRevert(CompagesVault.ZeroAddress.selector);
        new CompagesVault(address(0), operator, guardian, DELAY);
        vm.expectRevert(CompagesVault.ZeroAddress.selector);
        new CompagesVault(owner, address(0), guardian, DELAY);
        vm.expectRevert(CompagesVault.ZeroAddress.selector);
        new CompagesVault(owner, operator, address(0), DELAY);
        vm.expectRevert(CompagesVault.DelayTooLong.selector);
        new CompagesVault(owner, operator, guardian, 30 days + 1);
        vm.expectRevert(CompagesVault.DelayTooShort.selector);
        new CompagesVault(owner, operator, guardian, 1 hours - 1);
        vm.expectRevert(CompagesVault.DelayTooShort.selector);
        new CompagesVault(owner, operator, guardian, 0);
        new CompagesVault(owner, operator, guardian, 1 hours);
    }

    // ------------------------------------------------------------------
    // deposits
    // ------------------------------------------------------------------

    function test_depositEther() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit Deposited(0, ETH, alice, 1 ether, SEQ_ADDR);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
        assertEq(address(vault).balance, 1 ether);
        assertEq(vault.depositCount(), 1);
    }

    function test_depositToken() public {
        vm.startPrank(alice);
        token.approve(address(vault), 500e6);
        vm.expectEmit(true, true, true, true);
        emit Deposited(0, address(token), alice, 500e6, SEQ_ADDR);
        vault.depositToken(address(token), 500e6, SEQ_ADDR);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), 500e6);
    }

    function test_depositToken_feeOnTransfer_creditsReceivedAmount() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20(); // burns 1% on transfer
        fot.mint(alice, 100e18);
        vm.startPrank(alice);
        fot.approve(address(vault), 100e18);
        vm.expectEmit(true, true, true, true);
        emit Deposited(0, address(fot), alice, 99e18, SEQ_ADDR);
        vault.depositToken(address(fot), 100e18, SEQ_ADDR);
        vm.stopPrank();
        assertEq(fot.balanceOf(address(vault)), 99e18);
    }

    function test_depositToken_noReturnToken() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        usdt.mint(alice, 10e18);
        vm.startPrank(alice);
        usdt.approve(address(vault), 10e18);
        vault.depositToken(address(usdt), 10e18, SEQ_ADDR);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(vault)), 10e18);
    }

    function test_tokenWithNoCode_depositAndReleaseRevert() public {
        address ghost = makeAddr("ghost-token");
        vm.prank(alice);
        vm.expectRevert(CompagesVault.TokenTransferFailed.selector);
        vault.depositToken(ghost, 1, SEQ_ADDR);

        // Unconfigured, so a release queues; executing it cannot read a balance.
        bytes32 id = keccak256("ghost");
        vm.prank(operator);
        vault.release(ghost, payable(bob), 1, id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(CompagesVault.TokenTransferFailed.selector);
        vault.executeRelease(id);

        _unlimit(ghost);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.TokenTransferFailed.selector);
        vault.release(ghost, payable(bob), 1, keccak256("ghost2"));
    }

    function test_deposit_revertsWhenPaused() public {
        vm.prank(guardian);
        vault.pauseDeposits();
        vm.prank(alice);
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
        vm.prank(alice);
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.depositToken(address(token), 1, SEQ_ADDR);
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.depositEther{value: 0}(SEQ_ADDR);
        vm.prank(alice);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.depositToken(address(token), 0, SEQ_ADDR);
    }

    function test_deposit_addressLengthBounds() public {
        bytes memory b13 = new bytes(13);
        bytes memory b14 = new bytes(14);
        bytes memory b120 = new bytes(120);
        bytes memory b121 = new bytes(121);
        vm.startPrank(alice);
        vm.expectRevert(CompagesVault.BadSequentiaAddress.selector);
        vault.depositEther{value: 1}(string(b13));
        vault.depositEther{value: 1}(string(b14));
        vault.depositEther{value: 1}(string(b120));
        vm.expectRevert(CompagesVault.BadSequentiaAddress.selector);
        vault.depositEther{value: 1}(string(b121));
        token.approve(address(vault), 2);
        vm.expectRevert(CompagesVault.BadSequentiaAddress.selector);
        vault.depositToken(address(token), 1, string(b13));
        vm.expectRevert(CompagesVault.BadSequentiaAddress.selector);
        vault.depositToken(address(token), 1, string(b121));
        vault.depositToken(address(token), 1, string(b14));
        vault.depositToken(address(token), 1, string(b120));
        vm.stopPrank();
        assertEq(vault.depositCount(), 4);
    }

    function test_deposit_noncesIncrementAcrossKinds() public {
        vm.startPrank(alice);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
        token.approve(address(vault), 1e6);
        vault.depositToken(address(token), 1e6, SEQ_ADDR);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
        vm.stopPrank();
        assertEq(vault.depositCount(), 3);
    }

    function test_deposit_minimum() public {
        vm.startPrank(owner);
        vault.setMinDeposit(ETH, 1 ether);
        vault.setMinDeposit(address(token), 10e6);
        vm.stopPrank();
        assertEq(vault.minDeposit(ETH), 1 ether);

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.BelowMinDeposit.selector, 1 ether));
        vault.depositEther{value: 1 ether - 1}(SEQ_ADDR);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
        token.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.BelowMinDeposit.selector, 10e6));
        vault.depositToken(address(token), 10e6 - 1, SEQ_ADDR);
        vault.depositToken(address(token), 10e6, SEQ_ADDR);
        vm.stopPrank();
    }

    function test_deposit_minimumAppliesToCreditedAmount() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        fot.mint(alice, 100e18);
        vm.prank(owner);
        vault.setMinDeposit(address(fot), 100e18);
        vm.startPrank(alice);
        fot.approve(address(vault), 100e18);
        // Sends 100 but 99 arrives: below the minimum.
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.BelowMinDeposit.selector, 100e18));
        vault.depositToken(address(fot), 100e18, SEQ_ADDR);
        vm.stopPrank();
    }

    function test_deposit_cap() public {
        vm.startPrank(owner);
        vault.setDepositCap(ETH, 5 ether);
        vault.setDepositCap(address(token), 100e6);
        vm.stopPrank();
        assertEq(vault.depositCap(address(token)), 100e6);

        vm.startPrank(alice);
        vault.depositEther{value: 5 ether}(SEQ_ADDR);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.DepositCapExceeded.selector, 5 ether));
        vault.depositEther{value: 1}(SEQ_ADDR);
        token.approve(address(vault), type(uint256).max);
        vault.depositToken(address(token), 60e6, SEQ_ADDR);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.DepositCapExceeded.selector, 100e6));
        vault.depositToken(address(token), 41e6, SEQ_ADDR);
        vault.depositToken(address(token), 40e6, SEQ_ADDR);
        vm.stopPrank();

        // 0 lifts the cap.
        vm.prank(owner);
        vault.setDepositCap(ETH, 0);
        vm.prank(alice);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
    }

    function test_deposit_blockedToken() public {
        vm.prank(owner);
        vault.setTokenBlocked(address(token), true);
        assertTrue(vault.tokenBlocked(address(token)));
        vm.startPrank(alice);
        token.approve(address(vault), 1e6);
        vm.expectRevert(CompagesVault.TokenIsBlocked.selector);
        vault.depositToken(address(token), 1e6, SEQ_ADDR);
        vm.stopPrank();

        vm.prank(owner);
        vault.setTokenBlocked(address(token), false);
        vm.prank(alice);
        vault.depositToken(address(token), 1e6, SEQ_ADDR);

        vm.prank(owner);
        vault.setTokenBlocked(ETH, true);
        vm.prank(alice);
        vm.expectRevert(CompagesVault.TokenIsBlocked.selector);
        vault.depositEther{value: 1}(SEQ_ADDR);
    }

    function test_depositSetters_boundsAndAccess() public {
        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.ValueTooLarge.selector);
        vault.setMinDeposit(ETH, uint256(type(uint128).max) + 1);
        vm.expectRevert(CompagesVault.ValueTooLarge.selector);
        vault.setDepositCap(ETH, uint256(type(uint120).max) + 1);
        vm.stopPrank();

        address[3] memory others = [operator, guardian, alice];
        for (uint256 i; i < others.length; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(CompagesVault.NotOwner.selector);
            vault.setMinDeposit(ETH, 1);
            vm.expectRevert(CompagesVault.NotOwner.selector);
            vault.setDepositCap(ETH, 1);
            vm.expectRevert(CompagesVault.NotOwner.selector);
            vault.setTokenBlocked(ETH, true);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------
    // immediate releases
    // ------------------------------------------------------------------

    function test_release_token() public {
        _fund();
        _unlimit(address(token));
        bytes32 id = keccak256("seqtx:abc:0");
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit Released(id, address(token), bob, 400e6);
        vault.release(address(token), payable(bob), 400e6, id);
        assertEq(token.balanceOf(bob), 400e6);
        assertTrue(vault.processedRedemptions(id));
        assertEq(uint8(_state(id)), uint8(CompagesVault.ReleaseState.None));
    }

    function test_release_ether() public {
        _fund();
        _unlimit(ETH);
        bytes32 id = keccak256("seqtx:def:0");
        vm.prank(operator);
        vault.release(ETH, payable(bob), 3 ether, id);
        assertEq(bob.balance, 3 ether);
    }

    function test_release_noReturnToken() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        usdt.mint(alice, 10e18);
        vm.startPrank(alice);
        usdt.approve(address(vault), 10e18);
        vault.depositToken(address(usdt), 10e18, SEQ_ADDR);
        vm.stopPrank();
        _unlimit(address(usdt));
        vm.prank(operator);
        vault.release(address(usdt), payable(bob), 4e18, keccak256("u"));
        assertEq(usdt.balanceOf(bob), 4e18);
    }

    function test_release_replayReverts() public {
        _fund();
        _unlimit(address(token));
        bytes32 id = keccak256("seqtx:abc:0");
        vm.startPrank(operator);
        vault.release(address(token), payable(bob), 1e6, id);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.release(address(token), payable(bob), 1e6, id);
        // The refund path shares the replay map.
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.refund(address(token), payable(bob), 1e6, id);
        vm.stopPrank();
    }

    function test_release_badInputs() public {
        _fund();
        _unlimit(address(token));
        vm.startPrank(operator);
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.release(address(token), payable(address(0)), 1, keccak256("a"));
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.release(address(token), payable(address(vault)), 1, keccak256("a"));
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.release(address(token), payable(bob), 0, keccak256("a"));
        vm.stopPrank();
        assertFalse(vault.processedRedemptions(keccak256("a")));
    }

    function test_release_insufficientVaultBalance_revertsAndLeavesIdUnused() public {
        _escrow(100e6);
        _unlimit(address(token));
        bytes32 id = keccak256("big");
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 101e6, 100e6)
        );
        vault.release(address(token), payable(bob), 101e6, id);
        assertFalse(vault.processedRedemptions(id));
        // After a top-up the same id goes through.
        _escrow(1e6);
        vm.prank(operator);
        vault.release(address(token), payable(bob), 101e6, id);
        assertEq(token.balanceOf(bob), 101e6);
    }

    function test_release_insufficientGasReverts() public {
        _fund();
        _unlimit(ETH);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.InsufficientGasForPayout.selector);
        vault.release{gas: 150_000}(ETH, payable(bob), 1 ether, keccak256("g"));
        assertFalse(vault.processedRedemptions(keccak256("g")));
    }

    // ------------------------------------------------------------------
    // refunds
    // ------------------------------------------------------------------

    function test_refund_emitsRefundedNotReleased() public {
        _fund();
        _unlimit(address(token));
        bytes32 id = keccak256("compages:refund:11155111:7");
        vm.recordLogs();
        vm.prank(operator);
        vault.refund(address(token), payable(alice), 5e6, id);
        assertTrue(vault.processedRedemptions(id));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 refunded;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            assertTrue(logs[i].topics[0] != Released.selector, "refund must not emit Released");
            if (logs[i].topics[0] == Refunded.selector) {
                refunded++;
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(token)))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(alice))));
                assertEq(logs[i].topics[3], id);
                assertEq(abi.decode(logs[i].data, (uint256)), 5e6);
            }
        }
        assertEq(refunded, 1);
    }

    function test_refund_queuesAndExecutesAsRefund() public {
        _escrow(100e6);
        bytes32 id = keccak256("refund-q");
        vm.prank(operator);
        vault.refund(address(token), payable(alice), 50e6, id);
        (,,,,, bool isRefund) = vault.queuedRelease(id);
        assertTrue(isRefund);
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, true, true, true);
        emit Refunded(address(token), alice, 50e6, id);
        vault.executeRelease(id);
    }

    // ------------------------------------------------------------------
    // rate limit (token bucket)
    // ------------------------------------------------------------------

    function test_bucket_refillMath() public {
        _escrow(10_000e6);
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit ReleaseLimitSet(address(token), 0, 0, 100e6, 1e6);
        vault.setReleaseLimit(address(token), 100e6, 1e6); // full in 100 s

        // A fresh bucket starts empty.
        assertEq(vault.availableToRelease(address(token)), 0);
        vm.warp(block.timestamp + 50);
        assertEq(vault.availableToRelease(address(token)), 50e6);

        vm.prank(operator);
        vault.release(address(token), payable(bob), 40e6, keccak256("r1"));
        assertEq(token.balanceOf(bob), 40e6);
        assertEq(vault.availableToRelease(address(token)), 10e6);

        // 20 does not fit in 10: queued, bucket untouched.
        vm.prank(operator);
        vault.release(address(token), payable(bob), 20e6, keccak256("r2"));
        assertEq(uint8(_state(keccak256("r2"))), uint8(CompagesVault.ReleaseState.Queued));
        assertEq(vault.availableToRelease(address(token)), 10e6);

        vm.warp(block.timestamp + 5);
        assertEq(vault.availableToRelease(address(token)), 15e6);

        // Refill is capped at capacity.
        vm.warp(block.timestamp + 10_000);
        assertEq(vault.availableToRelease(address(token)), 100e6);

        // Exactly the whole bucket fits.
        vm.prank(operator);
        vault.release(address(token), payable(bob), 100e6, keccak256("r3"));
        assertEq(vault.availableToRelease(address(token)), 0);
    }

    function test_bucket_reconfigureNeverTopsUp() public {
        vm.prank(owner);
        vault.setReleaseLimit(ETH, 10 ether, 1 ether);
        vm.warp(block.timestamp + 4);
        assertEq(vault.availableToRelease(ETH), 4 ether);

        // Slowing the refill keeps the current level.
        vm.prank(owner);
        vault.setReleaseLimit(ETH, 10 ether, 0.1 ether);
        assertEq(vault.availableToRelease(ETH), 4 ether);

        // Lowering the capacity clamps it.
        vm.prank(owner);
        vault.setReleaseLimit(ETH, 1 ether, 0.1 ether);
        assertEq(vault.availableToRelease(ETH), 1 ether);

        // Capacity 0 stops immediate payouts entirely.
        vm.prank(owner);
        vault.setReleaseLimit(ETH, 0, 1 ether);
        vm.warp(block.timestamp + 100);
        assertEq(vault.availableToRelease(ETH), 0);
    }

    function test_bucket_unconfiguredTokenAlwaysQueues() public {
        _fund();
        vm.warp(block.timestamp + 365 days);
        bytes32 id = keccak256("any");
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit ReleaseQueued(id, address(token), bob, 1, block.timestamp + DELAY);
        vault.release(address(token), payable(bob), 1, id);
        assertEq(token.balanceOf(bob), 0);
        assertTrue(vault.processedRedemptions(id));
    }

    function test_bucket_perTokenIsolation() public {
        _fund();
        _unlimit(ETH);
        vm.prank(operator);
        vault.release(address(token), payable(bob), 1e6, keccak256("t"));
        assertEq(token.balanceOf(bob), 0); // token still unconfigured: queued
        vm.prank(operator);
        vault.release(ETH, payable(bob), 1 ether, keccak256("e"));
        assertEq(bob.balance, 1 ether);
    }

    function test_setReleaseLimit_boundsAndAccess() public {
        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.ValueTooLarge.selector);
        vault.setReleaseLimit(ETH, uint256(type(uint128).max) + 1, 0);
        vm.expectRevert(CompagesVault.ValueTooLarge.selector);
        vault.setReleaseLimit(ETH, 0, uint256(type(uint128).max) + 1);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setReleaseLimit(ETH, 1, 1);
        vm.prank(guardian);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setReleaseLimit(ETH, 1, 1);
    }

    // ------------------------------------------------------------------
    // queue
    // ------------------------------------------------------------------

    function test_queue_thenExecute() public {
        _escrow(100e6);
        bytes32 id = keccak256("q1");
        uint256 due = block.timestamp + DELAY;
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit ReleaseQueued(id, address(token), bob, 30e6, due);
        vault.release(address(token), payable(bob), 30e6, id);

        (address t, address to, uint256 amount, uint256 executeAfter, CompagesVault.ReleaseState s, bool isRefund) =
            vault.queuedRelease(id);
        assertEq(t, address(token));
        assertEq(to, bob);
        assertEq(amount, 30e6);
        assertEq(executeAfter, due);
        assertEq(uint8(s), uint8(CompagesVault.ReleaseState.Queued));
        assertFalse(isRefund);
        assertEq(vault.queuedTotal(address(token)), 30e6);

        vm.expectRevert(abi.encodeWithSelector(CompagesVault.ReleaseNotReady.selector, due));
        vault.executeRelease(id);
        vm.warp(due - 1);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.ReleaseNotReady.selector, due));
        vault.executeRelease(id);

        vm.warp(due);
        vm.prank(carol); // anyone
        vm.expectEmit(true, true, true, true);
        emit Released(id, address(token), bob, 30e6);
        vault.executeRelease(id);
        assertEq(token.balanceOf(bob), 30e6);
        assertEq(uint8(_state(id)), uint8(CompagesVault.ReleaseState.Executed));
        assertEq(vault.queuedTotal(address(token)), 0);

        vm.expectRevert(CompagesVault.NotQueued.selector);
        vault.executeRelease(id);
    }

    function test_queue_doubleQueueSameIdReverts() public {
        _escrow(100e6);
        bytes32 id = keccak256("q-dup");
        vm.startPrank(operator);
        vault.release(address(token), payable(bob), 30e6, id);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.release(address(token), payable(bob), 30e6, id);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.refund(address(token), payable(bob), 30e6, id);
        vm.stopPrank();
    }

    function test_queue_cancelReinstateExecute() public {
        _escrow(100e6);
        bytes32 id = keccak256("q2");
        vm.prank(operator);
        vault.release(address(token), payable(bob), 30e6, id);

        vm.prank(guardian);
        vm.expectEmit(true, true, true, true);
        emit ReleaseCancelled(id, guardian);
        vault.cancelRelease(id);
        assertEq(uint8(_state(id)), uint8(CompagesVault.ReleaseState.Cancelled));
        assertEq(vault.queuedTotal(address(token)), 0);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(CompagesVault.NotQueued.selector);
        vault.executeRelease(id);
        vm.prank(guardian);
        vm.expectRevert(CompagesVault.NotQueued.selector);
        vault.cancelRelease(id);
        // The id stays spent: the operator cannot route around a cancel.
        vm.prank(operator);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.release(address(token), payable(bob), 30e6, id);

        vm.prank(guardian);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.reinstateRelease(id);

        uint256 due = block.timestamp + DELAY;
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit ReleaseReinstated(id, due);
        vault.reinstateRelease(id);
        assertEq(vault.queuedTotal(address(token)), 30e6);
        vm.prank(owner);
        vm.expectRevert(CompagesVault.NotCancelled.selector);
        vault.reinstateRelease(id);

        vm.expectRevert(abi.encodeWithSelector(CompagesVault.ReleaseNotReady.selector, due));
        vault.executeRelease(id);
        vm.warp(due);
        vault.executeRelease(id);
        assertEq(token.balanceOf(bob), 30e6);
    }

    function test_queue_ownerCanCancel_operatorCannot() public {
        _escrow(100e6);
        bytes32 id = keccak256("q3");
        vm.prank(operator);
        vault.release(address(token), payable(bob), 30e6, id);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotGuardianOrOwner.selector);
        vault.cancelRelease(id);
        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotGuardianOrOwner.selector);
        vault.cancelRelease(id);
        vm.prank(owner);
        vault.cancelRelease(id);
        assertEq(uint8(_state(id)), uint8(CompagesVault.ReleaseState.Cancelled));
    }

    function test_queue_executeRespectsPauseAndBalance() public {
        _escrow(100e6);
        bytes32 id = keccak256("q4");
        vm.prank(operator);
        vault.release(address(token), payable(bob), 80e6, id);
        vm.warp(block.timestamp + DELAY);

        vm.prank(guardian);
        vault.pauseReleases();
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.executeRelease(id);
        vm.prank(owner);
        vault.unpauseReleases();

        vault.executeRelease(id);
        assertEq(token.balanceOf(bob), 80e6);
    }

    function test_queue_executeWaitsForLiquidity() public {
        // A release may be queued beyond what the vault holds; it executes
        // once the escrow is refilled.
        _escrow(100e6);
        bytes32 id = keccak256("q-short");
        vm.prank(operator);
        vault.release(address(token), payable(bob), 150e6, id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 150e6, 100e6)
        );
        vault.executeRelease(id);
        _escrow(50e6);
        vault.executeRelease(id);
        assertEq(token.balanceOf(bob), 150e6);
    }

    function test_queue_executeRequiresTheWholeReservationCovered() public {
        // With two queued releases and escrow for only one, neither executes:
        // a queued release is only paid while every other commitment stays
        // covered, so the shortfall is visible and refilled rather than
        // silently shifted onto whoever executes last.
        _escrow(100e6);
        vm.startPrank(operator);
        vault.release(address(token), payable(bob), 60e6, keccak256("a"));
        vault.release(address(token), payable(carol), 60e6, keccak256("b"));
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 60e6, 40e6)
        );
        vault.executeRelease(keccak256("a"));
        _escrow(20e6);
        vault.executeRelease(keccak256("a"));
        vault.executeRelease(keccak256("b"));
        assertEq(token.balanceOf(bob), 60e6);
        assertEq(token.balanceOf(carol), 60e6);
    }

    function test_queue_usesDelayAtQueueTime() public {
        _escrow(100e6);
        vm.prank(owner);
        vault.setReleaseDelay(1 hours);
        bytes32 id = keccak256("q5");
        vm.prank(operator);
        vault.release(address(token), payable(bob), 1e6, id);
        vm.prank(owner);
        vault.setReleaseDelay(10 days);
        vm.warp(block.timestamp + 1 hours);
        vault.executeRelease(id);
        assertEq(token.balanceOf(bob), 1e6);
    }

    function test_setReleaseDelay_boundsAndAccess() public {
        vm.prank(owner);
        vm.expectRevert(CompagesVault.DelayTooLong.selector);
        vault.setReleaseDelay(30 days + 1);
        vm.prank(owner);
        vault.setReleaseDelay(30 days);
        assertEq(vault.releaseDelay(), 30 days);
        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.DelayTooShort.selector);
        vault.setReleaseDelay(1 hours - 1);
        vm.expectRevert(CompagesVault.DelayTooShort.selector);
        vault.setReleaseDelay(0);
        vault.setReleaseDelay(1 hours);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setReleaseDelay(2 hours);
    }

    function test_executeRelease_unknownId() public {
        vm.expectRevert(CompagesVault.NotQueued.selector);
        vault.executeRelease(keccak256("nope"));
    }

    // ------------------------------------------------------------------
    // undeliverable payouts: owed and claim
    // ------------------------------------------------------------------

    function test_etherToRejectingContract_isOwed_thenClaimedElsewhere() public {
        _fund();
        _unlimit(ETH);
        RejectingReceiver r = new RejectingReceiver();
        bytes32 id = keccak256("stuck-87-days");
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit ReleaseDeferred(id, ETH, address(r), 2 ether);
        vault.release(ETH, payable(address(r)), 2 ether, id);

        assertTrue(vault.processedRedemptions(id));
        assertEq(vault.owed(ETH, address(r)), 2 ether);
        assertEq(vault.owedTotal(ETH), 2 ether);
        assertEq(address(vault).balance, 10 ether);
        assertEq(vault.unreservedBalance(ETH), 8 ether);

        // Nobody else can take it, and it cannot be claimed to the vault.
        vm.prank(bob);
        vm.expectRevert(CompagesVault.NothingOwed.selector);
        vault.claim(ETH, payable(bob));
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        r.claimFrom(vault, ETH, payable(address(vault)));
        // Claiming to itself fails loudly (it still rejects ether) and changes nothing.
        vm.expectRevert(CompagesVault.EtherTransferFailed.selector);
        r.claimFrom(vault, ETH, payable(address(r)));
        assertEq(vault.owed(ETH, address(r)), 2 ether);

        vm.expectEmit(true, true, true, true);
        emit Claimed(ETH, address(r), carol, 2 ether);
        r.claimFrom(vault, ETH, payable(carol));
        assertEq(carol.balance, 2 ether);
        assertEq(vault.owed(ETH, address(r)), 0);
        assertEq(vault.owedTotal(ETH), 0);
        assertEq(address(vault).balance, 8 ether);
    }

    function test_eip7702StyleRecipient_viaEtch() public {
        // An EOA with delegated code that rejects plain ether.
        _fund();
        _unlimit(ETH);
        address eoa = makeAddr("delegated-eoa");
        vm.etch(eoa, address(new RejectingReceiver()).code);
        vm.prank(operator);
        vault.release(ETH, payable(eoa), 1 ether, keccak256("7702"));
        assertEq(vault.owed(ETH, eoa), 1 ether);
        // The account's key can still call claim directly.
        vm.prank(eoa);
        vault.claim(ETH, payable(bob));
        assertEq(bob.balance, 1 ether);
    }

    function test_gasBurningRecipient_isOwed_notStuck() public {
        _fund();
        _unlimit(ETH);
        GasBurner burner = new GasBurner();
        vm.prank(operator);
        vault.release(ETH, payable(address(burner)), 1 ether, keccak256("burn"));
        assertEq(vault.owed(ETH, address(burner)), 1 ether);
    }

    function test_queuedExecutionToRejectingRecipient_isOwed() public {
        _fund();
        RejectingReceiver r = new RejectingReceiver();
        bytes32 id = keccak256("q-reject");
        vm.prank(operator);
        vault.release(ETH, payable(address(r)), 1 ether, id);
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, true, true, true);
        emit ReleaseDeferred(id, ETH, address(r), 1 ether);
        vault.executeRelease(id);
        assertEq(vault.owed(ETH, address(r)), 1 ether);
    }

    function test_tokenReturningFalse_isOwed() public {
        FalseReturnERC20 f = new FalseReturnERC20();
        f.mint(alice, 100e18);
        vm.startPrank(alice);
        f.approve(address(vault), 100e18);
        vault.depositToken(address(f), 100e18, SEQ_ADDR);
        vm.stopPrank();
        _unlimit(address(f));

        f.setFailTransfers(true);
        bytes32 id = keccak256("false");
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit ReleaseDeferred(id, address(f), bob, 10e18);
        vault.release(address(f), payable(bob), 10e18, id);
        assertEq(vault.owed(address(f), bob), 10e18);

        // Claim reverts while the token still refuses, then succeeds.
        vm.prank(bob);
        vm.expectRevert(CompagesVault.TokenTransferFailed.selector);
        vault.claim(address(f), payable(bob));
        f.setFailTransfers(false);
        vm.prank(bob);
        vault.claim(address(f), payable(bob));
        assertEq(f.balanceOf(bob), 10e18);
    }

    function test_blocklistedRecipient_isOwed_claimToCleanAddress() public {
        BlocklistPausableERC20 usdc = new BlocklistPausableERC20();
        usdc.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1000e6);
        vault.depositToken(address(usdc), 1000e6, SEQ_ADDR);
        vm.stopPrank();
        _unlimit(address(usdc));

        usdc.setBlocklisted(bob, true);
        vm.prank(operator);
        vault.release(address(usdc), payable(bob), 100e6, keccak256("bl"));
        assertEq(vault.owed(address(usdc), bob), 100e6);
        assertEq(usdc.balanceOf(address(vault)), 1000e6);

        // The owed account directs its claim to an address the token accepts.
        vm.prank(bob);
        vault.claim(address(usdc), payable(carol));
        assertEq(usdc.balanceOf(carol), 100e6);
    }

    function test_pausedToken_isOwed_thenClaimAfterUnpause() public {
        BlocklistPausableERC20 usdc = new BlocklistPausableERC20();
        usdc.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1000e6);
        vault.depositToken(address(usdc), 1000e6, SEQ_ADDR);
        vm.stopPrank();
        _unlimit(address(usdc));

        usdc.setPaused(true);
        vm.prank(operator);
        vault.release(address(usdc), payable(bob), 100e6, keccak256("p"));
        assertEq(vault.owed(address(usdc), bob), 100e6);

        vm.prank(bob);
        vm.expectRevert(CompagesVault.TokenTransferFailed.selector);
        vault.claim(address(usdc), payable(bob));
        usdc.setPaused(false);
        vm.prank(bob);
        vault.claim(address(usdc), payable(bob));
        assertEq(usdc.balanceOf(bob), 100e6);
    }

    function test_owedFundsAreReserved() public {
        _fund();
        _unlimit(ETH);
        RejectingReceiver r = new RejectingReceiver();
        vm.prank(operator);
        vault.release(ETH, payable(address(r)), 6 ether, keccak256("o1"));

        // 4 ether unreserved: a 5 ether release cannot eat the owed 6.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, ETH, 5 ether, 4 ether));
        vault.release(ETH, payable(bob), 5 ether, keccak256("o2"));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, ETH, 5 ether, 4 ether));
        vault.rebalanceOut(ETH, payable(bob), 5 ether, "x");
    }

    function test_claimWorksWhileReleasesPaused() public {
        _fund();
        _unlimit(ETH);
        RejectingReceiver r = new RejectingReceiver();
        vm.prank(operator);
        vault.release(ETH, payable(address(r)), 1 ether, keccak256("c"));
        vm.prank(guardian);
        vault.pauseReleases();
        r.claimFrom(vault, ETH, payable(carol));
        assertEq(carol.balance, 1 ether);
    }

    function test_reentrancyIsBlocked() public {
        _fund();
        _unlimit(ETH);
        ReentrantReceiver rr = new ReentrantReceiver(vault);
        vm.prank(operator);
        vault.release(ETH, payable(address(rr)), 1 ether, keccak256("re"));
        // It was paid (its receive swallowed the failed re-entry)...
        assertEq(address(rr).balance, 1 ether);
        // ...and the re-entrant claim did not get through.
        assertFalse(rr.reentered());
    }

    function test_rebasingToken_behaviour() public {
        // Rebasing tokens are unsupported; this pins down what happens.
        RebasingERC20 reb = new RebasingERC20();
        reb.mint(alice, 100e18);
        vm.startPrank(alice);
        reb.approve(address(vault), 100e18);
        vault.depositToken(address(reb), 100e18, SEQ_ADDR);
        vm.stopPrank();
        _unlimit(address(reb));

        // A positive rebase is just more unreserved balance.
        reb.rebase(1.1e18);
        assertEq(vault.unreservedBalance(address(reb)), 110e18);

        // Owe 100 to a recipient the token refuses, then shrink the balance below it.
        RejectingReceiver r = new RejectingReceiver();
        vm.mockCallRevert(address(reb), abi.encodeWithSelector(reb.transfer.selector, address(r), 100e18), "refuses");
        vm.prank(operator);
        vault.release(address(reb), payable(address(r)), 100e18, keccak256("reb"));
        vm.clearMockedCalls();
        assertEq(vault.owedTotal(address(reb)), 100e18);

        reb.rebase(0.5e18); // balance 55 < owed 100
        assertEq(vault.unreservedBalance(address(reb)), 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(reb), 1, 0));
        vault.release(address(reb), payable(bob), 1, keccak256("reb2"));
        vm.expectRevert(CompagesVault.TokenTransferFailed.selector);
        r.claimFrom(vault, address(reb), payable(carol));
    }

    // ------------------------------------------------------------------
    // roles and access control
    // ------------------------------------------------------------------

    function test_release_onlyOperator() public {
        _fund();
        _unlimit(address(token));
        address[3] memory others = [owner, guardian, alice];
        for (uint256 i; i < others.length; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(CompagesVault.NotOperator.selector);
            vault.release(address(token), payable(others[i]), 1e6, keccak256("x"));
            vm.expectRevert(CompagesVault.NotOperator.selector);
            vault.refund(address(token), payable(others[i]), 1e6, keccak256("x"));
            vm.stopPrank();
        }
    }

    function test_twoStepOwnership() public {
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferStarted(owner, bob);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner);
        assertEq(vault.pendingOwner(), bob);

        vm.prank(carol);
        vm.expectRevert(CompagesVault.NotPendingOwner.selector);
        vault.acceptOwnership();

        vm.prank(bob);
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferred(owner, bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
        assertEq(vault.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setOperator(owner);
    }

    function test_twoStepOwnership_cancel() public {
        vm.startPrank(owner);
        vault.transferOwnership(bob);
        vault.transferOwnership(address(0));
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(CompagesVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_roleSetters() public {
        vm.startPrank(owner);
        vm.expectEmit(true, true, true, true);
        emit OperatorChanged(operator, bob);
        vault.setOperator(bob);
        vault.setGuardian(carol);
        vm.expectRevert(CompagesVault.ZeroAddress.selector);
        vault.setOperator(address(0));
        vm.expectRevert(CompagesVault.ZeroAddress.selector);
        vault.setGuardian(address(0));
        vm.stopPrank();
        assertEq(vault.operator(), bob);
        assertEq(vault.guardian(), carol);

        address[2] memory others = [operator, guardian];
        for (uint256 i; i < others.length; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(CompagesVault.NotOwner.selector);
            vault.setOperator(others[i]);
            vm.expectRevert(CompagesVault.NotOwner.selector);
            vault.setGuardian(others[i]);
            vm.expectRevert(CompagesVault.NotOwner.selector);
            vault.transferOwnership(others[i]);
            vm.stopPrank();
        }
    }

    function test_guardian_canPauseButNeverUnpause() public {
        vm.startPrank(guardian);
        vault.pauseDeposits();
        vault.pauseReleases();
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.unpauseDeposits();
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.unpauseReleases();
        vm.stopPrank();
        assertTrue(vault.depositsPaused());
        assertTrue(vault.releasesPaused());

        vm.startPrank(owner);
        vault.unpauseDeposits();
        vault.unpauseReleases();
        vault.pauseDeposits(); // owner may pause too
        vm.stopPrank();
        assertTrue(vault.depositsPaused());
        assertFalse(vault.releasesPaused());
    }

    function test_guardian_cannotMoveFunds() public {
        _fund();
        _unlimit(address(token));
        vm.startPrank(guardian);
        vm.expectRevert(CompagesVault.NotOperator.selector);
        vault.release(address(token), payable(guardian), 1, keccak256("g"));
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.rebalanceOut(address(token), payable(guardian), 1, "g");
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setReleaseLimit(address(token), 1, 1);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setStablecoinBurner(address(token), guardian);
        vm.stopPrank();
    }

    function test_operator_cannotPauseOrAdminister() public {
        vm.startPrank(operator);
        vm.expectRevert(CompagesVault.NotGuardianOrOwner.selector);
        vault.pauseDeposits();
        vm.expectRevert(CompagesVault.NotGuardianOrOwner.selector);
        vault.pauseReleases();
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.rebalanceOut(address(token), payable(operator), 1, "x");
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // supply lock, stablecoin hand-off, rebalancing
    // ------------------------------------------------------------------

    function test_releasePause_isSeparateFromDepositPause() public {
        _escrow(100e6);
        _unlimit(address(token));

        vm.prank(guardian);
        vault.pauseDeposits();
        vm.prank(operator);
        vault.release(address(token), payable(bob), 10e6, keccak256("r1"));
        assertEq(token.balanceOf(bob), 10e6);

        vm.prank(guardian);
        vault.pauseReleases();
        vm.startPrank(operator);
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.release(address(token), payable(bob), 10e6, keccak256("r2"));
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.refund(address(token), payable(bob), 10e6, keccak256("r2"));
        vm.stopPrank();

        vm.prank(owner);
        vault.unpauseReleases();
        vm.prank(operator);
        vault.release(address(token), payable(bob), 10e6, keccak256("r2"));
        assertEq(token.balanceOf(bob), 20e6);
    }

    function test_burnLockedUSDC_onlyBurner_onlyWhenLocked_burnsEverything() public {
        _escrow(100e6);

        vm.prank(bob);
        vm.expectRevert(CompagesVault.NotBurner.selector);
        vault.burnLockedUSDC();

        vm.prank(owner);
        vault.setStablecoinBurner(address(token), bob);

        vm.prank(bob);
        vm.expectRevert(CompagesVault.SupplyNotLocked.selector);
        vault.burnLockedUSDC();

        _lock();

        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotBurner.selector);
        vault.burnLockedUSDC();

        uint256 supplyBefore = token.totalSupply();
        vm.prank(bob);
        vault.burnLockedUSDC();
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.totalSupply(), supplyBefore - 100e6);

        vm.prank(bob);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.burnLockedUSDC();
    }

    function test_burnLockedUSDC_sparesOwedAndQueued() public {
        BlocklistPausableERC20 usdc = new BlocklistPausableERC20();
        usdc.mint(alice, 1000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), 1000e6);
        vault.depositToken(address(usdc), 1000e6, SEQ_ADDR);
        vm.stopPrank();
        vm.prank(owner);
        vault.setReleaseLimit(address(usdc), 100e6, 100e6);
        vm.warp(block.timestamp + 1);

        usdc.setBlocklisted(bob, true);
        vm.startPrank(operator);
        vault.release(address(usdc), payable(bob), 100e6, keccak256("owed")); // owed 100
        vault.release(address(usdc), payable(carol), 300e6, keccak256("queued")); // queued 300
        vault.release(address(usdc), payable(carol), 50e6, keccak256("cancelled")); // queued, then cancelled
        vm.stopPrank();
        vm.prank(guardian);
        vault.cancelRelease(keccak256("cancelled"));
        usdc.setBlocklisted(bob, false);

        address circle = makeAddr("circle");
        vm.prank(owner);
        vault.setStablecoinBurner(address(usdc), circle);
        _lock();
        vm.prank(circle);
        vault.burnLockedUSDC();
        // 1000 - 100 owed - 300 queued - 50 cancelled = 550 burned.
        assertEq(usdc.balanceOf(address(vault)), 450e6);

        // The committed amounts are still paid.
        vm.prank(owner);
        vault.unpauseReleases();
        vm.prank(bob);
        vault.claim(address(usdc), payable(bob));
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(keccak256("queued"));
        assertEq(usdc.balanceOf(address(vault)), 50e6);
        assertEq(vault.cancelledTotal(address(usdc)), 50e6);
    }

    function test_burnLockedUSDC_revertsWhenTheTokenCannotBurn() public {
        NoReturnERC20 odd = new NoReturnERC20();
        odd.mint(alice, 100e6);
        vm.startPrank(alice);
        odd.approve(address(vault), 100e6);
        vault.depositToken(address(odd), 100e6, SEQ_ADDR);
        vm.stopPrank();

        vm.prank(owner);
        vault.setStablecoinBurner(address(odd), bob);
        _lock();

        vm.prank(bob);
        vm.expectRevert(CompagesVault.BurnFailed.selector);
        vault.burnLockedUSDC();
        assertEq(odd.balanceOf(address(vault)), 100e6);
    }

    function test_burnLockedUSDC_noStablecoin() public {
        vm.prank(owner);
        vault.setStablecoinBurner(address(0), bob);
        vm.prank(bob);
        vm.expectRevert(CompagesVault.NoStablecoinConfigured.selector);
        vault.burnLockedUSDC();
    }

    function test_rebalanceOut_isOwnerOnly_andRespectsTheSupplyLock() public {
        _escrow(100e6);

        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.rebalanceOut(address(token), payable(bob), 10e6, "solana");
        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.rebalanceOut(address(token), payable(bob), 10e6, "solana");

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit Rebalanced(address(token), bob, 40e6, "solana");
        vault.rebalanceOut(address(token), payable(bob), 40e6, "solana");
        assertEq(token.balanceOf(bob), 40e6);
        assertEq(token.balanceOf(address(vault)), 60e6);

        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.rebalanceOut(address(token), payable(address(0)), 1, "x");
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.rebalanceOut(address(token), payable(bob), 0, "x");
        vault.pauseReleases();
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.rebalanceOut(address(token), payable(bob), 1e6, "solana");
        vm.stopPrank();
    }

    function test_rebalanceOut_ether() public {
        _fund();
        vm.prank(owner);
        vault.rebalanceOut(ETH, payable(bob), 4 ether, "base");
        assertEq(bob.balance, 4 ether);
        RejectingReceiver r = new RejectingReceiver();
        vm.prank(owner);
        vm.expectRevert(CompagesVault.EtherTransferFailed.selector);
        vault.rebalanceOut(ETH, payable(address(r)), 1 ether, "x");
    }

    // ------------------------------------------------------------------
    // reservation of queued and cancelled releases
    // ------------------------------------------------------------------

    function test_regression_rebalanceCannotSpendQueuedFunds() public {
        _escrow(100e6);
        bytes32 id = keccak256("r1");
        vm.prank(operator);
        vault.release(address(token), payable(alice), 100e6, id); // unconfigured: queued
        assertEq(vault.unreservedBalance(address(token)), 0);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 100e6, 0)
        );
        vault.rebalanceOut(address(token), payable(owner), 100e6, "x");
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(id);
        assertEq(token.balanceOf(alice), 1_000_000e6);
    }

    function test_regression_immediatePayoutCannotSpendQueuedFunds() public {
        _escrow(100e6);
        vm.prank(operator);
        vault.release(address(token), payable(alice), 100e6, keccak256("big")); // queued
        _unlimit(address(token));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 100e6, 0)
        );
        vault.release(address(token), payable(bob), 100e6, keccak256("small"));
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(keccak256("big"));
    }

    function test_regression_guardianCancelDoesNotMakeEscrowBurnable() public {
        _escrow(100e6);
        vm.prank(operator);
        vault.release(address(token), payable(alice), 40e6, keccak256("q"));
        address burner = makeAddr("burner");
        vm.prank(owner);
        vault.setStablecoinBurner(address(token), burner);
        vm.startPrank(guardian);
        vault.pauseDeposits();
        vault.pauseReleases();
        vault.cancelRelease(keccak256("q"));
        vm.stopPrank();
        assertEq(vault.cancelledTotal(address(token)), 40e6);
        vm.prank(burner);
        vault.burnLockedUSDC();
        assertEq(token.balanceOf(address(vault)), 40e6); // the cancelled release survives

        // The owner can still reinstate and pay it.
        vm.startPrank(owner);
        vault.unpauseReleases();
        vault.reinstateRelease(keccak256("q"));
        vm.stopPrank();
        assertEq(vault.cancelledTotal(address(token)), 0);
        assertEq(vault.queuedTotal(address(token)), 40e6);
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(keccak256("q"));
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_cancelledFundsStayReserved() public {
        _escrow(100e6);
        vm.prank(operator);
        vault.release(address(token), payable(alice), 70e6, keccak256("c"));
        vm.prank(guardian);
        vault.cancelRelease(keccak256("c"));
        assertEq(vault.unreservedBalance(address(token)), 30e6);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 31e6, 30e6)
        );
        vault.rebalanceOut(address(token), payable(owner), 31e6, "x");
    }

    function test_discardCancelledRelease_clearsABogusQueueEntry() public {
        // A compromised operator queues an absurd release; the guardian
        // cancels it; while it is reserved nothing else can move.
        _escrow(100e6);
        bytes32 bogus = keccak256("bogus");
        vm.prank(operator);
        vault.release(address(token), payable(operator), type(uint128).max, bogus); // over any limit: queued
        vm.prank(guardian);
        vault.cancelRelease(bogus);
        _unlimit(address(token));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(token), 1e6, 0));
        vault.release(address(token), payable(bob), 1e6, keccak256("legit"));

        vm.prank(guardian);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.discardCancelledRelease(bogus);
        vm.prank(owner);
        vault.discardCancelledRelease(bogus);
        assertEq(uint8(_state(bogus)), uint8(CompagesVault.ReleaseState.Discarded));
        assertEq(vault.cancelledTotal(address(token)), 0);
        assertTrue(vault.processedRedemptions(bogus));

        vm.prank(operator);
        vault.release(address(token), payable(bob), 1e6, keccak256("legit"));
        assertEq(token.balanceOf(bob), 1e6);

        // A discarded entry can be neither reinstated, amended nor executed.
        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.NotCancelled.selector);
        vault.reinstateRelease(bogus);
        vm.expectRevert(CompagesVault.NotCancelled.selector);
        vault.discardCancelledRelease(bogus);
        vm.expectRevert(CompagesVault.NotCancelled.selector);
        vault.amendCancelledRelease(bogus, false, bob, 0, bytes32(0), 0);
        vm.stopPrank();
        vm.expectRevert(CompagesVault.NotQueued.selector);
        vault.executeRelease(bogus);
    }

    function test_amendCancelledRelease_direct() public {
        _fund();
        RejectingReceiver r = new RejectingReceiver();
        bytes32 id = keccak256("amend");
        vm.prank(operator);
        vault.release(ETH, payable(address(r)), 1 ether, id); // queued
        vm.prank(guardian);
        vault.cancelRelease(id);

        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.amendCancelledRelease(id, false, address(0), 0, bytes32(0), 0);
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.amendCancelledRelease(id, false, address(vault), 0, bytes32(0), 0);
        // Ether cannot be sent over CCTP.
        vm.expectRevert(CompagesVault.CctpDisabled.selector);
        vault.amendCancelledRelease(id, true, address(0), 5, keccak256("x"), 0);
        vm.stopPrank();

        vm.prank(guardian);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.amendCancelledRelease(id, false, carol, 0, bytes32(0), 0);

        vm.startPrank(owner);
        vault.amendCancelledRelease(id, false, carol, 7, keccak256("ignored"), 3);
        (bool viaCctp, uint32 domain, bytes32 recipient, uint256 maxFee) = vault.queuedCctpRelease(id);
        assertFalse(viaCctp);
        assertEq(domain, 0);
        assertEq(recipient, bytes32(0));
        assertEq(maxFee, 0);
        vault.reinstateRelease(id);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(id);
        assertEq(carol.balance, 1 ether);
    }

    function test_amendCancelledRelease_onlyCancelled() public {
        _escrow(100e6);
        bytes32 id = keccak256("q");
        vm.prank(operator);
        vault.release(address(token), payable(bob), 1e6, id);
        vm.prank(owner);
        vm.expectRevert(CompagesVault.NotCancelled.selector);
        vault.amendCancelledRelease(id, false, carol, 0, bytes32(0), 0);
        vm.prank(owner);
        vm.expectRevert(CompagesVault.NotCancelled.selector);
        vault.amendCancelledRelease(keccak256("unknown"), false, carol, 0, bytes32(0), 0);
    }

    // ------------------------------------------------------------------
    // ether funding
    // ------------------------------------------------------------------

    event RebalancedIn(address indexed token, uint256 amount, uint32 indexed sourceDomain, bytes32 sender);

    function test_regression_etherCanMoveBetweenVaults() public {
        CompagesVault other = new CompagesVault(owner, operator, guardian, DELAY);
        vm.prank(alice);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);

        // A vault has no receive(), so it cannot be a rebalance target directly...
        vm.prank(owner);
        vm.expectRevert(CompagesVault.EtherTransferFailed.selector);
        vault.rebalanceOut(ETH, payable(address(other)), 1 ether, "vault2");

        // ...but the owner can carry the ether across with fundEther.
        vm.prank(owner);
        vault.rebalanceOut(ETH, payable(owner), 1 ether, "vault2");
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(other));
        emit RebalancedIn(ETH, 1 ether, type(uint32).max, bytes32(uint256(uint160(owner))));
        other.fundEther{value: 1 ether}();
        assertEq(address(other).balance, 1 ether);
        assertEq(other.depositCount(), 0);
    }

    function test_fundEther_onlyOwnerAndNonZero() public {
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.fundEther{value: 0}();
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.fundEther{value: 1}();
        // Plain ether sent to the vault is refused.
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------
    // payout gas
    // ------------------------------------------------------------------

    /// Whatever gas the executor supplies, a recipient that needs the full
    /// PAYOUT_GAS either gets it or the call reverts: starvation never turns
    /// into a deferral.
    function test_regression_gasFloorNeverStarves() public {
        vm.deal(address(vault), 1000 ether);
        uint256 deferred;
        for (uint256 g = 200_000; g < 400_000; g += 500) {
            PickyReceiver r = new PickyReceiver();
            vm.prank(operator);
            vault.release(ETH, payable(address(r)), 1, keccak256(abi.encode(g)));
        }
        vm.warp(block.timestamp + DELAY + 1);
        for (uint256 g = 200_000; g < 400_000; g += 500) {
            bytes32 id = keccak256(abi.encode(g));
            (, address to,,,,) = vault.queuedRelease(id);
            try vault.executeRelease{gas: g}(id) {
                if (!PickyReceiver(payable(to)).got()) deferred++;
            } catch {}
        }
        assertEq(deferred, 0);
    }

    // ------------------------------------------------------------------
    // deploy script
    // ------------------------------------------------------------------

    function test_deployScript() public {
        vm.setEnv("OWNER", vm.toString(owner));
        vm.setEnv("OPERATOR", vm.toString(operator));
        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("RELEASE_DELAY", "86400");
        CompagesVault v = new Deploy().run();
        assertEq(v.VERSION(), 3);
        assertEq(v.owner(), owner);
        assertEq(v.operator(), operator);
        assertEq(v.guardian(), guardian);
        assertEq(v.releaseDelay(), 86400);
    }
}
