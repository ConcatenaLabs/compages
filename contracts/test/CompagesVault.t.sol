// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CompagesVault} from "../src/CompagesVault.sol";
import {MockERC20, FeeOnTransferERC20, NoReturnERC20} from "./mocks/MockTokens.sol";

contract CompagesVaultTest is Test {
    CompagesVault vault;
    MockERC20 token;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    string constant SEQ_ADDR = "tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty";

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

    function setUp() public {
        vm.prank(owner);
        vault = new CompagesVault(operator);
        token = new MockERC20("Mock USD", "MUSD", 6);
        token.mint(alice, 1_000_000e6);
        vm.deal(alice, 100 ether);
    }

    // ---------------- deposits ----------------

    function test_depositEther() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit Deposited(0, address(0), alice, 1 ether, SEQ_ADDR);
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

    function test_deposit_revertsWhenPaused() public {
        vm.prank(owner);
        vault.setDepositsPaused(true);
        vm.prank(alice);
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.depositEther{value: 0}(SEQ_ADDR);
        vm.prank(alice);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.depositToken(address(token), 0, SEQ_ADDR);
    }

    function test_deposit_revertsOnBadSequentiaAddress() public {
        vm.prank(alice);
        vm.expectRevert(CompagesVault.BadSequentiaAddress.selector);
        vault.depositEther{value: 1 ether}("short");
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

    // ---------------- releases ----------------

    function _fund() private {
        vm.startPrank(alice);
        vault.depositEther{value: 10 ether}(SEQ_ADDR);
        token.approve(address(vault), 1000e6);
        vault.depositToken(address(token), 1000e6, SEQ_ADDR);
        vm.stopPrank();
    }

    function test_release_token() public {
        _fund();
        bytes32 id = keccak256("seqtx:abc:0");
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit Released(id, address(token), bob, 400e6);
        vault.release(address(token), payable(bob), 400e6, id);
        assertEq(token.balanceOf(bob), 400e6);
        assertTrue(vault.processedRedemptions(id));
    }

    function test_release_ether() public {
        _fund();
        bytes32 id = keccak256("seqtx:def:0");
        vm.prank(operator);
        vault.release(address(0), payable(bob), 3 ether, id);
        assertEq(bob.balance, 3 ether);
    }

    function test_release_replayReverts() public {
        _fund();
        bytes32 id = keccak256("seqtx:abc:0");
        vm.startPrank(operator);
        vault.release(address(token), payable(bob), 1e6, id);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.release(address(token), payable(bob), 1e6, id);
        vm.stopPrank();
    }

    function test_release_onlyOperator() public {
        _fund();
        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotOperator.selector);
        vault.release(address(token), payable(alice), 1e6, keccak256("x"));
        vm.prank(owner); // owner is not automatically operator
        vm.expectRevert(CompagesVault.NotOperator.selector);
        vault.release(address(token), payable(owner), 1e6, keccak256("x"));
    }

    // ---------------- admin ----------------

    function test_admin_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setOperator(alice);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setDepositsPaused(true);

        vm.startPrank(owner);
        vault.setOperator(bob);
        assertEq(vault.operator(), bob);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), bob);
        vm.stopPrank();
    }
}
