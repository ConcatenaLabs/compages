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

    // ---------------- supply lock and stablecoin hand-off ----------------

    /// Put an escrow in the vault to work with.
    function _escrow(uint256 amount) private {
        vm.startPrank(alice);
        token.approve(address(vault), amount);
        vault.depositToken(address(token), amount, SEQ_ADDR);
        vm.stopPrank();
    }

    function test_releasePause_isSeparateFromDepositPause() public {
        _escrow(100e6);

        // Pausing deposits alone must leave users able to exit: that is the
        // routine pause, and stranding funds is no part of it.
        vm.prank(owner);
        vault.setDepositsPaused(true);
        vm.prank(operator);
        vault.release(address(token), payable(bob), 10e6, keccak256("r1"));
        assertEq(token.balanceOf(bob), 10e6);

        // Pausing releases as well locks the supply: nothing moves in either
        // direction, which is what makes an exact reconciliation possible.
        vm.prank(owner);
        vault.setReleasesPaused(true);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.release(address(token), payable(bob), 10e6, keccak256("r2"));

        vm.prank(owner);
        vault.setReleasesPaused(false);
        vm.prank(operator);
        vault.release(address(token), payable(bob), 10e6, keccak256("r2"));
        assertEq(token.balanceOf(bob), 20e6);
    }

    function test_burnLockedUSDC_onlyBurner_onlyWhenLocked_burnsEverything() public {
        _escrow(100e6);

        // Nothing can burn until the owner names both the stablecoin and the
        // issuer's burner address.
        vm.prank(bob);
        vm.expectRevert(CompagesVault.NotBurner.selector);
        vault.burnLockedUSDC();

        vm.prank(owner);
        vault.setStablecoinBurner(address(token), bob);

        // The burner still cannot act while the supply is moving.
        vm.prank(bob);
        vm.expectRevert(CompagesVault.SupplyNotLocked.selector);
        vault.burnLockedUSDC();

        vm.startPrank(owner);
        vault.setDepositsPaused(true);
        vault.setReleasesPaused(true);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotBurner.selector);
        vault.burnLockedUSDC();

        uint256 supplyBefore = token.totalSupply();
        vm.prank(bob);
        vault.burnLockedUSDC();

        // The escrow is destroyed, not moved: after the hand-off the bridged
        // asset is the issuer's liability, so tokens left here would
        // double-count the backing.
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.totalSupply(), supplyBefore - 100e6);

        vm.prank(bob);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.burnLockedUSDC();
    }

    function test_rebalanceOut_isOperatorOnly_andRespectsTheSupplyLock() public {
        _escrow(100e6);

        vm.prank(alice);
        vm.expectRevert(CompagesVault.NotOperator.selector);
        vault.rebalanceOut(address(token), payable(bob), 10e6, "solana");

        vm.prank(operator);
        vault.rebalanceOut(address(token), payable(bob), 40e6, "solana");
        assertEq(token.balanceOf(bob), 40e6);
        assertEq(token.balanceOf(address(vault)), 60e6);

        // A locked supply must not be moved by a rebalance either.
        vm.prank(owner);
        vault.setReleasesPaused(true);
        vm.prank(operator);
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.rebalanceOut(address(token), payable(bob), 1e6, "solana");
    }

    function test_burnLockedUSDC_revertsWhenTheTokenCannotBurn() public {
        // A token with no burn function must fail loudly rather than look like
        // it destroyed an escrow the vault still holds.
        NoReturnERC20 odd = new NoReturnERC20();
        odd.mint(alice, 100e6);
        vm.startPrank(alice);
        odd.approve(address(vault), 100e6);
        vault.depositToken(address(odd), 100e6, SEQ_ADDR);
        vm.stopPrank();

        vm.startPrank(owner);
        vault.setStablecoinBurner(address(odd), bob);
        vault.setDepositsPaused(true);
        vault.setReleasesPaused(true);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(CompagesVault.BurnFailed.selector);
        vault.burnLockedUSDC();
        assertEq(odd.balanceOf(address(vault)), 100e6);
    }
}
