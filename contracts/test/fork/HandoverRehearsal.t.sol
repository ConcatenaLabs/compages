// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CompagesVault} from "../../src/CompagesVault.sol";

/// @dev The parts of Circle's FiatTokenV2_2 (circlefin/stablecoin-evm) the
///      rehearsal touches.
interface IFiatToken {
    function masterMinter() external view returns (address);
    function blacklister() external view returns (address);
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function isMinter(address account) external view returns (bool);
    function minterAllowance(address minter) external view returns (uint256);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklist(address account) external;
    function isBlacklisted(address account) external view returns (bool);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function version() external view returns (string memory);

    event Burn(address indexed burner, uint256 amount);
}

/// Rehearses the Ethereum side of handing the vault's USDC escrow to Circle
/// under the Bridged USDC Standard, against the vault and USDC exactly as they
/// are deployed on Sepolia, on a local fork. Nothing is broadcast: every role
/// is impersonated on the fork.
///
/// Phases: supply lock (guardian pauses deposits, in-flight releases settle,
/// guardian pauses releases); the owner names Circle's burner; Circle's
/// masterMinter makes the vault a zero-allowance minter so FiatToken lets it
/// burn; the burner calls burnLockedUSDC(). The in-flight phase leaves one
/// release queued, one cancelled and one owed, so the burn has to spare all
/// three reservations.
///
/// Skipped unless REHEARSAL_RPC_URL is set, so a plain `forge test` stays
/// offline. contrib/handover-rehearsal.sh sets it and runs this with -vv,
/// which prints the transcript.
///
/// Environment (all optional but the URL):
///   REHEARSAL_RPC_URL  Sepolia RPC to fork
///   FORK_BLOCK         pin the fork to a block (default: latest)
///   VAULT              vault address (default: the live Sepolia vault)
///   USDC               USDC address (default: Sepolia USDC)
///   CIRCLE_BURNER      the burner Circle names (default: a fresh address)
contract HandoverRehearsal is Test {
    address constant LIVE_VAULT = 0x7B702D6A2E2351F0c4E549642e65AbABC0324384;
    address constant SEPOLIA_USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    string constant SEQ_ADDR = "tb1qrehearsalrehearsalrehearsalrehearsal0";

    CompagesVault vault;
    IFiatToken usdc;
    address owner;
    address guardian;
    address operator;
    address masterMinter;
    address burner;

    // The in-flight redemptions: one paid, one cancelled, one left queued,
    // and one whose blacklisted recipient turns it into an owed amount.
    bytes32 constant ID_PAID = keccak256("rehearsal:paid");
    bytes32 constant ID_CANCELLED = keccak256("rehearsal:cancelled");
    bytes32 constant ID_QUEUED = keccak256("rehearsal:queued");
    bytes32 constant ID_OWED = keccak256("rehearsal:owed");
    address paidTo = makeAddr("redeemer-paid");
    address cancelledTo = makeAddr("redeemer-cancelled");
    address queuedTo = makeAddr("redeemer-queued");
    address owedTo = makeAddr("redeemer-blacklisted");
    uint256 amtPaid;
    uint256 amtCancelled;
    uint256 amtQueued;
    uint256 amtOwed;

    function setUp() public {
        string memory url = vm.envOr("REHEARSAL_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true, "REHEARSAL_RPC_URL not set; run contrib/handover-rehearsal.sh");
            return;
        }
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);

        vault = CompagesVault(vm.envOr("VAULT", LIVE_VAULT));
        usdc = IFiatToken(vm.envOr("USDC", SEPOLIA_USDC));
        burner = vm.envOr("CIRCLE_BURNER", makeAddr("circle-burner"));
        owner = vault.owner();
        guardian = vault.guardian();
        operator = vault.operator();
        masterMinter = usdc.masterMinter();
    }

    function test_handoverToCircle() public {
        _title("Circle hand-off rehearsal: Ethereum side");
        console.log("fork block        ", block.number);
        console.log("vault             ", address(vault));
        console.log("vault VERSION     ", vault.VERSION());
        console.log("USDC              ", address(usdc));
        console.log("USDC version      ", usdc.version());
        console.log("owner             ", owner);
        console.log("guardian          ", guardian);
        console.log("operator          ", operator);
        console.log("USDC masterMinter ", masterMinter);
        console.log("Circle burner     ", burner);
        assertEq(usdc.decimals(), 6, "USDC decimals");
        assertTrue(!vault.depositsPaused() && !vault.releasesPaused(), "the live vault starts unpaused");
        assertEq(vault.lockedStablecoin(), address(0), "no stablecoin named yet");
        assertFalse(usdc.isMinter(address(vault)), "the vault is not yet a USDC minter");
        _topUpIfEmpty();
        _state("starting state");

        _putRedemptionsInFlight();
        _lockTheSupply();
        _nameTheBurner();
        _burnAndCheck();
        _title("Rehearsal passed");
    }

    function _putRedemptionsInFlight() private {
        _title("Setup: put redemptions in flight");
        // The live bucket is larger than the escrow, so every release would
        // pay at once. A zero-capacity bucket sends them all to the queue,
        // which is what an in-flight redemption at lock time looks like.
        uint256 bal = usdc.balanceOf(address(vault));
        amtPaid = bal * 20 / 100;
        amtCancelled = bal * 10 / 100;
        amtQueued = bal * 10 / 100;
        amtOwed = bal * 5 / 100;

        vm.prank(owner);
        vault.setReleaseLimit(address(usdc), 0, 0);
        _ok("owner     setReleaseLimit(USDC, 0, 0)");
        vm.startPrank(operator);
        vault.release(address(usdc), payable(paidTo), amtPaid, ID_PAID);
        _ok(string.concat("operator  release ", _usd(amtPaid), " -> queued (will be executed)"));
        vault.release(address(usdc), payable(cancelledTo), amtCancelled, ID_CANCELLED);
        _ok(string.concat("operator  release ", _usd(amtCancelled), " -> queued (will be cancelled)"));
        vault.release(address(usdc), payable(queuedTo), amtQueued, ID_QUEUED);
        _ok(string.concat("operator  release ", _usd(amtQueued), " -> queued (stays queued)"));
        vault.release(address(usdc), payable(owedTo), amtOwed, ID_OWED);
        _ok(string.concat("operator  release ", _usd(amtOwed), " -> queued (recipient will be blacklisted)"));
        vm.stopPrank();
        vm.prank(usdc.blacklister());
        usdc.blacklist(owedTo);
        _ok("blacklister blacklist(recipient of the last release), so its payout defers");
        _state("in flight");
    }

    function _lockTheSupply() private {
        _title("Phase 2a: supply lock, deposits");
        vm.expectEmit(address(vault));
        emit CompagesVault.DepositsPausedSet(guardian, false, true);
        vm.prank(guardian);
        vault.pauseDeposits();
        _ok("guardian  pauseDeposits()");
        assertTrue(vault.depositsPaused());
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.depositToken(address(usdc), 1e6, SEQ_ADDR);
        _reverted("anyone    depositToken(USDC, 1)", "DepositsArePaused");
        vm.deal(address(this), 1 ether);
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);
        _reverted("anyone    depositEther(1 ether)", "DepositsArePaused");

        // ------------------------------------------------------------------
        _title("Phase 2b: in-flight releases settle");
        vm.warp(block.timestamp + vault.releaseDelay());
        console.log("  (warped past releaseDelay:", vault.releaseDelay(), "s)");
        vm.expectEmit(address(vault));
        emit CompagesVault.Released(ID_PAID, address(usdc), paidTo, amtPaid);
        vault.executeRelease(ID_PAID);
        _ok(string.concat("anyone    executeRelease(paid): Released ", _usd(amtPaid)));
        vm.expectEmit(address(vault));
        emit CompagesVault.ReleaseDeferred(ID_OWED, address(usdc), owedTo, amtOwed);
        vault.executeRelease(ID_OWED);
        _ok(string.concat("anyone    executeRelease(blacklisted): ReleaseDeferred, owed ", _usd(amtOwed)));
        vm.prank(guardian);
        vault.cancelRelease(ID_CANCELLED);
        _ok(string.concat("guardian  cancelRelease(cancelled): ", _usd(amtCancelled), " stays reserved"));
        assertEq(usdc.balanceOf(paidTo), amtPaid, "paid recipient");
        assertEq(vault.owedTotal(address(usdc)), amtOwed, "owed");
        _state("settled");

        // ------------------------------------------------------------------
        _title("Phase 2c: supply lock, releases");
        vm.expectEmit(address(vault));
        emit CompagesVault.ReleasesPausedSet(guardian, false, true);
        vm.prank(guardian);
        vault.pauseReleases();
        _ok("guardian  pauseReleases()");
        assertTrue(vault.releasesPaused());
        _assertReleasesStopped();
    }

    function _nameTheBurner() private {
        _title("Phase 4a: owner names Circle's burner");
        vm.expectRevert(CompagesVault.NotBurner.selector);
        vm.prank(burner);
        vault.burnLockedUSDC();
        _reverted("burner    burnLockedUSDC() before being named", "NotBurner");
        vm.expectEmit(address(vault));
        emit CompagesVault.StablecoinBurnerSet(address(usdc), burner, address(0), address(0));
        vm.prank(owner);
        vault.setStablecoinBurner(address(usdc), burner);
        _ok("owner     setStablecoinBurner(USDC, burner)");
        assertEq(vault.lockedStablecoin(), address(usdc));
        assertEq(vault.stablecoinBurner(), burner);

        // Without Circle's step, FiatToken refuses the burn: only a minter may
        // burn, so the vault's call fails and the whole call reverts.
        vm.expectRevert(CompagesVault.BurnFailed.selector);
        vm.prank(burner);
        vault.burnLockedUSDC();
        _reverted("burner    burnLockedUSDC() before the vault is a minter", "BurnFailed");

        // ------------------------------------------------------------------
        _title("Phase 4b: Circle's masterMinter lets the vault burn");
        vm.prank(masterMinter);
        assertTrue(usdc.configureMinter(address(vault), 0));
        _ok("masterMinter configureMinter(vault, 0)");
        assertTrue(usdc.isMinter(address(vault)), "vault is a minter");
        assertEq(usdc.minterAllowance(address(vault)), 0, "with nothing to mint");
        vm.expectRevert();
        vm.prank(address(vault));
        usdc.mint(address(vault), 1);
        _reverted("vault     mint(1) as a zero-allowance minter", "FiatToken allowance");

        // ------------------------------------------------------------------
        _title("Phase 4c: only the burner can burn");
        address[5] memory others = [owner, guardian, operator, masterMinter, makeAddr("stranger")];
        string[5] memory names = ["owner       ", "guardian    ", "operator    ", "masterMinter", "stranger    "];
        for (uint256 i; i < others.length; i++) {
            vm.expectRevert(CompagesVault.NotBurner.selector);
            vm.prank(others[i]);
            vault.burnLockedUSDC();
            _reverted(string.concat(names[i], " burnLockedUSDC()"), "NotBurner");
        }
    }

    function _burnAndCheck() private {
        _title("Phase 4d: Circle's burner burns the escrow");
        uint256 supplyBefore = usdc.totalSupply();
        uint256 balanceBefore = usdc.balanceOf(address(vault));
        uint256 owedT = vault.owedTotal(address(usdc));
        uint256 queuedT = vault.queuedTotal(address(usdc));
        uint256 cancelledT = vault.cancelledTotal(address(usdc));
        uint256 reserved = owedT + queuedT + cancelledT;
        uint256 expected = vault.unreservedBalance(address(usdc));
        assertEq(expected, balanceBefore - reserved, "unreserved = balance - owed - queued - cancelled");
        assertGt(expected, 0, "something to burn");
        _state("before the burn");

        vm.expectEmit(address(usdc));
        emit IFiatToken.Burn(address(vault), expected);
        vm.expectEmit(address(vault));
        emit CompagesVault.LockedStablecoinBurned(address(usdc), expected);
        vm.prank(burner);
        vault.burnLockedUSDC();
        _ok(string.concat("burner    burnLockedUSDC(): LockedStablecoinBurned(USDC, ", _usd(expected), ")"));

        uint256 supplyAfter = usdc.totalSupply();
        uint256 balanceAfter = usdc.balanceOf(address(vault));
        console.log("  USDC totalSupply before", _usd(supplyBefore));
        console.log("  USDC totalSupply after ", _usd(supplyAfter));
        console.log("  decrease               ", _usd(supplyBefore - supplyAfter));
        assertEq(supplyBefore - supplyAfter, expected, "supply fell by exactly the unreserved escrow");
        assertEq(balanceAfter, reserved, "vault keeps exactly owed + queued + cancelled");
        assertEq(vault.owedTotal(address(usdc)), owedT, "owed untouched");
        assertEq(vault.queuedTotal(address(usdc)), queuedT, "queue untouched");
        assertEq(vault.cancelledTotal(address(usdc)), cancelledT, "cancelled untouched");
        assertEq(vault.unreservedBalance(address(usdc)), 0);
        _state("after the burn");

        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vm.prank(burner);
        vault.burnLockedUSDC();
        _reverted("burner    burnLockedUSDC() again", "ZeroAmount (nothing unreserved left)");

        // ------------------------------------------------------------------
        _title("After: the lock holds and reserved escrow stays payable");
        assertTrue(vault.depositsPaused() && vault.releasesPaused(), "both pauses hold");
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.depositToken(address(usdc), 1e6, SEQ_ADDR);
        _reverted("anyone    depositToken(USDC, 1)", "DepositsArePaused");
        _assertReleasesStopped();

        // An owed amount is already paid as far as the bridge is concerned, so
        // its claim is not stopped by the release pause.
        address claimTo = makeAddr("claim-destination");
        vm.prank(owedTo);
        vault.claim(address(usdc), payable(claimTo));
        _ok(string.concat("recipient claim(USDC, clean address): ", _usd(amtOwed), " paid while releases stay paused"));
        assertEq(usdc.balanceOf(claimTo), amtOwed);
        assertEq(usdc.balanceOf(address(vault)), queuedT + cancelledT, "vault holds the queued and cancelled releases");
        assertEq(usdc.totalSupply(), supplyAfter, "a claim moves USDC, it does not burn it");
        _state("final");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _assertReleasesStopped() private {
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vm.prank(operator);
        vault.release(address(usdc), payable(queuedTo), 1, keccak256("rehearsal:new"));
        _reverted("operator  release(USDC, 1)", "ReleasesArePaused");
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.executeRelease(ID_QUEUED);
        _reverted("anyone    executeRelease(queued)", "ReleasesArePaused");
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vm.prank(owner);
        vault.rebalanceOut(address(usdc), payable(owner), 1, "rehearsal");
        _reverted("owner     rebalanceOut(USDC, 1)", "ReleasesArePaused");
    }

    /// An emptied vault would leave nothing to burn and the rehearsal would
    /// prove nothing, so escrow is minted in through a temporary minter first.
    function _topUpIfEmpty() private {
        if (usdc.balanceOf(address(vault)) >= 1e6) return;
        address temp = makeAddr("rehearsal-temp-minter");
        vm.prank(masterMinter);
        usdc.configureMinter(temp, 10e6);
        vm.prank(temp);
        usdc.mint(address(vault), 10e6);
        console.log("  (vault held under 1 USDC: minted 10 USDC into it through a temporary minter)");
    }

    function _state(string memory label) private view {
        address t = address(usdc);
        console.log(string.concat("  -- ", label, " --"));
        console.log("    vault USDC balance ", _usd(usdc.balanceOf(address(vault))));
        console.log("    owed               ", _usd(vault.owedTotal(t)));
        console.log("    queued             ", _usd(vault.queuedTotal(t)));
        console.log("    cancelled          ", _usd(vault.cancelledTotal(t)));
        console.log("    unreserved         ", _usd(vault.unreservedBalance(t)));
        console.log("    USDC totalSupply   ", _usd(usdc.totalSupply()));
        console.log(
            string.concat(
                "    depositsPaused=",
                vault.depositsPaused() ? "true" : "false",
                " releasesPaused=",
                vault.releasesPaused() ? "true" : "false"
            )
        );
    }

    function _title(string memory s) private pure {
        console.log("");
        console.log(string.concat("== ", s));
    }

    function _ok(string memory s) private pure {
        console.log(string.concat("  ok        ", s));
    }

    function _reverted(string memory s, string memory reason) private pure {
        console.log(string.concat("  refused   ", s, " -> ", reason));
    }

    /// 6-decimal amount as "123.456789 USDC".
    function _usd(uint256 a) private pure returns (string memory) {
        bytes memory frac = bytes(vm.toString(a % 1e6));
        while (frac.length < 6) frac = bytes.concat("0", frac);
        return string.concat(vm.toString(a / 1e6), ".", string(frac), " USDC");
    }
}
