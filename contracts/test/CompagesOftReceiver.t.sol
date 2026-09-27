// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CompagesVault} from "../src/CompagesVault.sol";
import {CompagesOftReceiver} from "../src/CompagesOftReceiver.sol";
import {MockERC20, TetherLikeERC20} from "./mocks/MockTokens.sol";
import {MockEndpointV2, MockOftAdapter} from "./mocks/MockLayerZero.sol";

/// LayerZero OFT v2 arrivals (USDT0) through CompagesOftReceiver into the vault.
contract CompagesOftReceiverTest is Test {
    CompagesVault vault;
    CompagesOftReceiver receiver;
    MockEndpointV2 endpoint;
    MockOftAdapter oft;
    TetherLikeERC20 usdt;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address executor = makeAddr("executor");
    address alice = makeAddr("alice");

    uint256 constant DELAY = 1 days;
    uint32 constant ETHEREUM_EID = 30101;
    uint32 constant ARBITRUM_EID = 30110;
    bytes32 constant ARB_SENDER = keccak256("arbitrum-depositor");
    string constant SEQ_ADDR = "tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty";

    event Deposited(
        uint256 indexed nonce, address indexed token, address indexed from, uint256 amount, string sequentiaAddress
    );
    event OftDeposit(uint256 indexed nonce, uint32 indexed srcEid, bytes32 sender, bytes32 guid, uint256 amount);
    event RebalancedIn(address indexed token, uint256 amount, uint32 indexed sourceDomain, bytes32 sender);
    event OftUnrecognized(uint32 indexed srcEid, bytes32 sender, bytes32 guid, uint256 amount, bytes composeMsg);
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

    function setUp() public {
        vault = new CompagesVault(owner, operator, guardian, DELAY);
        endpoint = new MockEndpointV2(ETHEREUM_EID);
        usdt = new TetherLikeERC20();
        oft = new MockOftAdapter(address(endpoint), address(usdt));
        usdt.mint(address(oft), 10_000_000e6); // the adapter's lockbox
        receiver = new CompagesOftReceiver(address(vault));
        vm.startPrank(owner);
        receiver.setOft(address(endpoint), address(oft));
        receiver.setEnabled(true);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    uint64 private _nonceSeq;

    /// The OFT credits `amount` to the receiver and queues `payload`; returns
    /// the compose message as the endpoint stored it.
    function _arrive(bytes32 guid, uint256 amount, bytes memory payload) internal returns (bytes memory) {
        return oft.deliver(ARBITRUM_EID, ++_nonceSeq, guid, address(receiver), amount, ARB_SENDER, payload);
    }

    /// The executor (or anyone) delivers a queued compose.
    function _compose(bytes32 guid, bytes memory message) internal {
        vm.prank(executor);
        endpoint.lzCompose(address(oft), address(receiver), guid, 0, message, "");
    }

    function _depositPayload(string memory seqAddr) internal pure returns (bytes memory) {
        return abi.encodePacked("compages:deposit:", seqAddr);
    }

    function _vaultEvents(Vm.Log[] memory logs, address emitter) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == emitter) n++;
        }
    }

    // ------------------------------------------------------------------
    // layout fidelity
    // ------------------------------------------------------------------

    /// A real USDT0 compose message queued on Ethereum mainnet by the USDT0
    /// adapter (0x6C96dE32...; ComposeSent in tx 0x9279a125..., block
    /// 26070281; Arbitrum -> Ethereum). The mock adapter must produce it byte
    /// for byte from its fields, and the receiver must read those fields back
    /// out of it, which pins the OFTComposeMsgCodec offsets on both sides.
    function test_layout_matchesARealUsdt0Compose() public {
        bytes memory real =
            hex"00000000000075840000759e00000000000000000000000000000000000000000000000000000013e07a73a0000000000000000000000000374f13dd8deccc71b71a33fbd0d5d5653028ca24426270b1fa5eef79291a3b409d6b2f5135912f6c94645f85509b89e06e20b752";
        bytes32 guid = 0xd5427549c4d268896e1310fd7b604f55d7c7d31f1be1953f03e7ee337503c679;
        bytes32 composeFrom = bytes32(uint256(uint160(0x374F13dD8DeCcC71B71a33Fbd0D5D5653028cA24)));
        bytes memory payload = hex"426270b1fa5eef79291a3b409d6b2f5135912f6c94645f85509b89e06e20b752";
        uint256 amount = 85_370.5e6;

        bytes memory built = oft.deliver(ARBITRUM_EID, 30084, guid, address(receiver), amount, composeFrom, payload);
        assertEq(real.length, 108);
        assertEq(built, real);

        // Not a Compages payload: it lands in the vault and is reported with
        // every field decoded from the real bytes.
        vm.expectEmit(true, true, true, true, address(receiver));
        emit OftUnrecognized(ARBITRUM_EID, composeFrom, guid, amount, payload);
        _compose(guid, real);
        assertEq(usdt.balanceOf(address(vault)), amount);
    }

    // ------------------------------------------------------------------
    // deposits
    // ------------------------------------------------------------------

    function test_deposit_creditsTheVault() public {
        // A direct deposit first, so the OFT one shares the vault's counter.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);

        bytes32 guid = keccak256("g1");
        bytes memory m = _arrive(guid, 250e6, _depositPayload(SEQ_ADDR));
        assertEq(usdt.balanceOf(address(receiver)), 250e6);

        vm.expectEmit(true, true, true, true, address(vault));
        emit Deposited(1, address(usdt), address(receiver), 250e6, SEQ_ADDR);
        vm.expectEmit(true, true, true, true, address(receiver));
        emit OftDeposit(1, ARBITRUM_EID, ARB_SENDER, guid, 250e6);
        _compose(guid, m);

        assertEq(vault.depositCount(), 2);
        assertEq(usdt.balanceOf(address(vault)), 250e6);
        assertEq(usdt.balanceOf(address(receiver)), 0);
        assertEq(usdt.allowance(address(receiver), address(vault)), 0);
        assertTrue(receiver.composed(guid));
    }

    /// Deposited USDT is ordinary vault escrow: released under the vault's
    /// own rate limit, and a second deposit works despite USDT's rule against
    /// changing one nonzero allowance to another.
    function test_deposit_isReleasableEscrow() public {
        _compose(keccak256("a"), _arrive(keccak256("a"), 100e6, _depositPayload(SEQ_ADDR)));
        _compose(keccak256("b"), _arrive(keccak256("b"), 50e6, _depositPayload(SEQ_ADDR)));
        assertEq(vault.depositCount(), 2);

        vm.prank(owner);
        vault.setReleaseLimit(address(usdt), 1000e6, 1000e6);
        vm.warp(block.timestamp + 1);
        vm.prank(operator);
        vault.release(address(usdt), payable(alice), 120e6, keccak256("r"));
        assertEq(usdt.balanceOf(alice), 120e6);
        assertEq(usdt.balanceOf(address(vault)), 30e6);
    }

    function test_deposit_addressLengthBounds() public {
        bytes memory a13 = new bytes(13);
        bytes memory a14 = new bytes(14);
        bytes memory a120 = new bytes(120);
        bytes memory a121 = new bytes(121);
        for (uint256 i; i < 120; i++) {
            if (i < 13) a13[i] = "a";
            if (i < 14) a14[i] = "a";
            a120[i] = "a";
            a121[i] = "a";
        }
        a121[120] = "a";
        bytes[4] memory payloads = [
            abi.encodePacked("compages:deposit:", a13),
            abi.encodePacked("compages:deposit:", a14),
            abi.encodePacked("compages:deposit:", a120),
            abi.encodePacked("compages:deposit:", a121)
        ];
        for (uint256 i; i < 4; i++) {
            bytes32 guid = keccak256(abi.encode("len", i));
            _compose(guid, _arrive(guid, 1e6, payloads[i]));
        }
        assertEq(vault.depositCount(), 2); // only 14 and 120 bytes
        assertEq(usdt.balanceOf(address(vault)), 4e6);
    }

    // ------------------------------------------------------------------
    // rebalance and unrecognised payloads
    // ------------------------------------------------------------------

    function test_rebalance_emitsRebalancedInOnly() public {
        bytes32 guid = keccak256("rb");
        bytes memory m = _arrive(guid, 500e6, "compages:rebalance");
        vm.recordLogs();
        _compose(guid, m);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_vaultEvents(logs, address(vault)), 0);
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(receiver)) continue;
            seen++;
            assertEq(logs[i].topics[0], RebalancedIn.selector);
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(usdt)))));
            assertEq(logs[i].topics[2], bytes32(uint256(ARBITRUM_EID)));
            (uint256 amount, bytes32 sender) = abi.decode(logs[i].data, (uint256, bytes32));
            assertEq(amount, 500e6);
            assertEq(sender, ARB_SENDER);
        }
        assertEq(seen, 1);
        assertEq(vault.depositCount(), 0);
        assertEq(usdt.balanceOf(address(vault)), 500e6);
    }

    function test_unrecognized_isKeptInTheVaultAndReported() public {
        bytes[5] memory bad = [
            bytes("x"),
            bytes("compages:deposit"),
            bytes("compages:rebalance "),
            bytes("COMPAGES:DEPOSIT:tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty"),
            bytes("something else entirely")
        ];
        for (uint256 i; i < bad.length; i++) {
            bytes32 guid = keccak256(abi.encode("bad", i));
            bytes memory m = _arrive(guid, 10e6, bad[i]);
            vm.expectEmit(true, true, true, true, address(receiver));
            emit OftUnrecognized(ARBITRUM_EID, ARB_SENDER, guid, 10e6, bad[i]);
            _compose(guid, m);
        }
        assertEq(vault.depositCount(), 0);
        assertEq(usdt.balanceOf(address(vault)), 50e6);
        assertEq(usdt.balanceOf(address(receiver)), 0);
    }

    /// The vault's deposit rules cannot keep tokens out that have already
    /// arrived; a deposit it refuses lands as an unrecognised arrival.
    function test_depositRefusedByTheVault_isReported() public {
        vm.prank(owner);
        vault.setMinDeposit(address(usdt), 100e6);
        bytes32 guid = keccak256("small");
        bytes memory payload = _depositPayload(SEQ_ADDR);
        bytes memory m = _arrive(guid, 5e6, payload);
        vm.expectEmit(true, true, true, true, address(receiver));
        emit OftUnrecognized(ARBITRUM_EID, ARB_SENDER, guid, 5e6, payload);
        _compose(guid, m);

        vm.prank(owner);
        vault.setTokenBlocked(address(usdt), true);
        guid = keccak256("blocked");
        _compose(guid, _arrive(guid, 500e6, payload));

        assertEq(vault.depositCount(), 0);
        assertEq(usdt.balanceOf(address(vault)), 505e6);
        assertEq(usdt.allowance(address(receiver), address(vault)), 0);
    }

    /// Starving the vault call must not turn a valid deposit into a refund.
    function test_deposit_tooLittleGasReverts() public {
        bytes32 guid = keccak256("gas");
        bytes memory m = _arrive(guid, 10e6, _depositPayload(SEQ_ADDR));
        vm.prank(executor);
        vm.expectRevert(CompagesOftReceiver.InsufficientGasForDeposit.selector);
        endpoint.lzCompose{gas: 200_000}(address(oft), address(receiver), guid, 0, m, "");
        assertEq(usdt.balanceOf(address(receiver)), 10e6);
        // 400k for the whole compose is enough (the README's figure).
        vm.prank(executor);
        endpoint.lzCompose{gas: 400_000}(address(oft), address(receiver), guid, 0, m, "");
        assertEq(vault.depositCount(), 1);
    }

    // ------------------------------------------------------------------
    // authentication
    // ------------------------------------------------------------------

    function test_wrongCaller_reverts() public {
        bytes32 guid = keccak256("wc");
        bytes memory m = _arrive(guid, 10e6, _depositPayload(SEQ_ADDR));

        // Straight to the receiver, naming the real OFT.
        vm.prank(alice);
        vm.expectRevert(CompagesOftReceiver.NotEndpoint.selector);
        receiver.lzCompose(address(oft), guid, m, alice, "");

        // Through another endpoint, where anyone can queue anything.
        MockEndpointV2 rogue = new MockEndpointV2(ETHEREUM_EID);
        vm.prank(address(oft));
        rogue.sendCompose(address(receiver), guid, 0, m);
        vm.expectRevert(CompagesOftReceiver.NotEndpoint.selector);
        rogue.lzCompose(address(oft), address(receiver), guid, 0, m, "");

        // The genuine compose is untouched and still lands.
        _compose(guid, m);
        assertEq(vault.depositCount(), 1);
    }

    function test_wrongOft_reverts() public {
        // Another OFT on the same endpoint, crediting some other token.
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        MockOftAdapter otherOft = new MockOftAdapter(address(endpoint), address(other));
        other.mint(address(otherOft), 1000e6);
        bytes32 guid = keccak256("wo");
        bytes memory m =
            otherOft.deliver(ARBITRUM_EID, 1, guid, address(receiver), 10e6, ARB_SENDER, _depositPayload(SEQ_ADDR));

        vm.expectRevert(CompagesOftReceiver.NotOft.selector);
        endpoint.lzCompose(address(otherOft), address(receiver), guid, 0, m, "");
        // Stray USDT of the right amount does not help it either.
        usdt.mint(address(receiver), 10e6);
        vm.expectRevert(CompagesOftReceiver.NotOft.selector);
        endpoint.lzCompose(address(otherOft), address(receiver), guid, 0, m, "");
        assertEq(vault.depositCount(), 0);
    }

    function test_amountMismatch_reverts() public {
        // A compose for more than the OFT credited.
        bytes32 guid = keccak256("am");
        oft.deliver(ARBITRUM_EID, 1, guid, address(receiver), 10e6, ARB_SENDER, "");
        bytes memory claimed = oft.encodeCompose(1, ARBITRUM_EID, 11e6, ARB_SENDER, _depositPayload(SEQ_ADDR));
        oft.composeOnly(address(receiver), guid, 0, claimed);
        vm.expectRevert(abi.encodeWithSelector(CompagesOftReceiver.OftAmountNotReceived.selector, 11e6, 10e6));
        _compose(guid, claimed);

        // A compose with nothing credited at all.
        bytes32 guid2 = keccak256("am2");
        bytes memory none = oft.encodeCompose(2, ARBITRUM_EID, 1e6, ARB_SENDER, "compages:rebalance");
        oft.composeOnly(address(receiver), guid2, 0, none);
        // The 10e6 still held from the first arrival would cover it, so clear
        // that out first.
        vm.prank(owner);
        receiver.sweepToVault(address(usdt), 10e6);
        vm.expectRevert(abi.encodeWithSelector(CompagesOftReceiver.OftAmountNotReceived.selector, 1e6, 0));
        _compose(guid2, none);

        // A zero amount and a truncated message.
        bytes32 guid3 = keccak256("am3");
        bytes memory zero = oft.encodeCompose(3, ARBITRUM_EID, 0, ARB_SENDER, "compages:rebalance");
        oft.composeOnly(address(receiver), guid3, 0, zero);
        vm.expectRevert(CompagesOftReceiver.OftNothingReceived.selector);
        _compose(guid3, zero);
        bytes32 guid4 = keccak256("am4");
        bytes memory short = new bytes(75);
        oft.composeOnly(address(receiver), guid4, 0, short);
        vm.expectRevert(CompagesOftReceiver.OftBadMessage.selector);
        _compose(guid4, short);
        assertEq(vault.depositCount(), 0);
    }

    function test_replay_reverts() public {
        bytes32 guid = keccak256("rp");
        bytes memory m = _arrive(guid, 10e6, _depositPayload(SEQ_ADDR));
        _compose(guid, m);

        // The endpoint will not deliver the same compose twice...
        vm.expectRevert(
            abi.encodeWithSelector(MockEndpointV2.LZ_ComposeNotFound.selector, bytes32(uint256(1)), keccak256(m))
        );
        _compose(guid, m);

        // ...and the receiver refuses the guid again even when the OFT queues
        // it a second time under another index, with fresh tokens behind it.
        usdt.mint(address(receiver), 10e6);
        oft.composeOnly(address(receiver), guid, 1, m);
        vm.expectRevert(CompagesOftReceiver.AlreadyComposed.selector);
        endpoint.lzCompose(address(oft), address(receiver), guid, 1, m, "");
        assertEq(vault.depositCount(), 1);
    }

    function test_value_reverts() public {
        bytes32 guid = keccak256("v");
        bytes memory m = _arrive(guid, 10e6, _depositPayload(SEQ_ADDR));
        vm.deal(executor, 1 ether);
        vm.prank(executor);
        vm.expectRevert(CompagesOftReceiver.UnexpectedValue.selector);
        endpoint.lzCompose{value: 1}(address(oft), address(receiver), guid, 0, m, "");
        _compose(guid, m); // redelivered without value
        assertEq(vault.depositCount(), 1);
    }

    // ------------------------------------------------------------------
    // disabled and paused
    // ------------------------------------------------------------------

    function test_disabled_revertsAndStaysQueued() public {
        vm.prank(guardian);
        receiver.setEnabled(false);
        bytes32 guid = keccak256("off");
        bytes memory m = _arrive(guid, 10e6, "compages:rebalance");
        vm.expectRevert(CompagesOftReceiver.OftDisabled.selector);
        _compose(guid, m);
        assertEq(endpoint.composeQueue(address(oft), address(receiver), guid, 0), keccak256(m));
        assertEq(usdt.balanceOf(address(receiver)), 10e6);

        vm.prank(owner);
        receiver.setEnabled(true);
        _compose(guid, m);
        assertEq(usdt.balanceOf(address(vault)), 10e6);

        // Clearing the configuration disables it too.
        vm.prank(owner);
        receiver.setOft(address(0), address(0));
        assertFalse(receiver.enabled());
        bytes32 guid2 = keccak256("off2");
        bytes memory m2 = _arrive(guid2, 10e6, "compages:rebalance");
        vm.expectRevert(CompagesOftReceiver.OftDisabled.selector);
        _compose(guid2, m2);
    }

    function test_depositsPaused_revertsButRebalanceStillLands() public {
        vm.prank(guardian);
        vault.pauseDeposits();
        bytes32 dep = keccak256("p1");
        bytes memory depMsg = _arrive(dep, 10e6, _depositPayload(SEQ_ADDR));
        vm.expectRevert(CompagesOftReceiver.DepositsArePaused.selector);
        _compose(dep, depMsg);
        bytes32 bad = keccak256("p2");
        bytes memory badMsg = _arrive(bad, 3e6, "compages:deposit:short");
        vm.expectRevert(CompagesOftReceiver.DepositsArePaused.selector);
        _compose(bad, badMsg);

        bytes32 rb = keccak256("p3");
        _compose(rb, _arrive(rb, 5e6, "compages:rebalance"));
        assertEq(usdt.balanceOf(address(vault)), 5e6);
        assertEq(usdt.balanceOf(address(receiver)), 13e6);

        vm.prank(owner);
        vault.unpauseDeposits();
        _compose(dep, depMsg);
        _compose(bad, badMsg);
        assertEq(vault.depositCount(), 1);
        assertEq(usdt.balanceOf(address(vault)), 18e6);
        assertEq(usdt.balanceOf(address(receiver)), 0);
    }

    // ------------------------------------------------------------------
    // configuration and roles
    // ------------------------------------------------------------------

    function test_setOft_validationAndAccess() public {
        address[3] memory others = [operator, guardian, alice];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(CompagesOftReceiver.NotOwner.selector);
            receiver.setOft(address(0), address(0));
        }

        vm.startPrank(owner);
        vm.expectRevert(CompagesOftReceiver.OftMisconfigured.selector);
        receiver.setOft(address(endpoint), address(0));
        vm.expectRevert(CompagesOftReceiver.OftMisconfigured.selector);
        receiver.setOft(address(0), address(oft));
        MockEndpointV2 elsewhere = new MockEndpointV2(ETHEREUM_EID);
        vm.expectRevert(CompagesOftReceiver.OftMisconfigured.selector);
        receiver.setOft(address(elsewhere), address(oft));
        MockOftAdapter tokenless = new MockOftAdapter(address(endpoint), address(0));
        vm.expectRevert(CompagesOftReceiver.OftMisconfigured.selector);
        receiver.setOft(address(endpoint), address(tokenless));

        vm.expectEmit(true, true, true, true, address(receiver));
        emit OftSet(address(endpoint), address(oft), address(usdt), address(0), address(0), address(0));
        receiver.setOft(address(0), address(0));
        vm.expectRevert(CompagesOftReceiver.OftMisconfigured.selector);
        receiver.setEnabled(true);
        receiver.setOft(address(endpoint), address(oft));
        vm.stopPrank();
        assertEq(receiver.token(), address(usdt));
        assertEq(receiver.oft(), address(oft));
        assertEq(receiver.endpoint(), address(endpoint));
    }

    function test_setEnabled_roles() public {
        vm.prank(operator);
        vm.expectRevert(CompagesOftReceiver.NotGuardianOrOwner.selector);
        receiver.setEnabled(false);

        vm.expectEmit(true, true, true, true, address(receiver));
        emit EnabledSet(guardian, true, false);
        vm.prank(guardian);
        receiver.setEnabled(false);

        address[2] memory notOwner = [guardian, operator];
        for (uint256 i; i < notOwner.length; i++) {
            vm.prank(notOwner[i]);
            vm.expectRevert(CompagesOftReceiver.NotOwner.selector);
            receiver.setEnabled(true);
        }
        vm.prank(owner);
        receiver.setEnabled(true);
        assertTrue(receiver.enabled());
    }

    /// The receiver has no keys of its own: a change of the vault's owner or
    /// guardian carries over at once.
    function test_rolesFollowTheVault() public {
        address newOwner = makeAddr("new-owner");
        address newGuardian = makeAddr("new-guardian");
        vm.prank(owner);
        vault.transferOwnership(newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();
        vm.prank(newOwner);
        vault.setGuardian(newGuardian);

        vm.prank(owner);
        vm.expectRevert(CompagesOftReceiver.NotOwner.selector);
        receiver.setOft(address(0), address(0));
        vm.prank(guardian);
        vm.expectRevert(CompagesOftReceiver.NotGuardianOrOwner.selector);
        receiver.setEnabled(false);

        vm.prank(newGuardian);
        receiver.setEnabled(false);
        vm.prank(newOwner);
        receiver.setEnabled(true);
    }

    /// Tokens that reach the receiver without a compose (an OFT send with no
    /// compose message) can be moved into the vault, and only there.
    function test_sweepToVault() public {
        oft.deliver(ARBITRUM_EID, 1, keccak256("plain"), address(receiver), 7e6, ARB_SENDER, "");
        assertEq(usdt.balanceOf(address(receiver)), 7e6);

        address[3] memory others = [operator, guardian, alice];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(CompagesOftReceiver.NotOwner.selector);
            receiver.sweepToVault(address(usdt), 7e6);
        }
        vm.startPrank(owner);
        vm.expectRevert(CompagesOftReceiver.ZeroAmount.selector);
        receiver.sweepToVault(address(usdt), 0);
        vm.expectEmit(true, true, true, true, address(receiver));
        emit Swept(address(usdt), 7e6);
        receiver.sweepToVault(address(usdt), 7e6);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(vault)), 7e6);
        assertEq(vault.depositCount(), 0);
    }

    function test_constants() public view {
        assertEq(receiver.COMPOSE_DEPOSIT_TAG(), vault.CCTP_DEPOSIT_TAG());
        assertEq(receiver.COMPOSE_REBALANCE_TAG(), vault.CCTP_REBALANCE_TAG());
        assertEq(address(receiver.vault()), address(vault));
        assertEq(receiver.VERSION(), 1);
    }

    function test_constructor_requiresAVault() public {
        vm.expectRevert(CompagesOftReceiver.ZeroAddress.selector);
        new CompagesOftReceiver(address(0));
        vm.expectRevert(CompagesOftReceiver.ZeroAddress.selector);
        new CompagesOftReceiver(alice);
    }
}
