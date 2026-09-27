// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CompagesVault} from "../src/CompagesVault.sol";
import {BlocklistPausableERC20, MockERC20} from "./mocks/MockTokens.sol";
import {MockMessageTransmitterV2, MockTokenMessengerV2} from "./mocks/MockCctp.sol";

/// CCTP V2 inbound (receiveCctp) and outbound (releaseViaCctp/refundViaCctp).
contract CompagesVaultCctpTest is Test {
    CompagesVault vault;
    MockMessageTransmitterV2 transmitter;
    MockTokenMessengerV2 messenger;
    BlocklistPausableERC20 usdc;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");

    uint256 constant DELAY = 1 days;
    uint32 constant SOLANA = 5;
    uint32 constant BASE = 6;
    bytes32 constant REMOTE_TM = bytes32(uint256(0xAAAA));
    bytes32 constant SOL_USDC = 0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7;
    bytes32 constant SOL_SENDER = keccak256("solana-depositor");
    string constant SEQ_ADDR = "tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty";
    bytes constant ATTESTATION = "valid";

    event Deposited(
        uint256 indexed nonce, address indexed token, address indexed from, uint256 amount, string sequentiaAddress
    );
    event CctpDeposit(
        uint256 indexed nonce, uint32 indexed sourceDomain, bytes32 sender, bytes32 cctpNonce, uint256 amount
    );
    event RebalancedIn(address indexed token, uint256 amount, uint32 indexed sourceDomain, bytes32 sender);
    event CctpForwarded(uint32 indexed sourceDomain, bytes32 indexed mintRecipient, bytes32 cctpNonce);
    event CctpUnrecognized(
        uint32 indexed sourceDomain, bytes32 sender, bytes32 cctpNonce, uint256 amount, bytes hookData
    );
    event ReleaseAmended(
        bytes32 indexed redemptionId,
        bool viaCctp,
        address to,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        uint256 maxFee
    );
    event ReleasedViaCctp(
        bytes32 indexed redemptionId, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount
    );
    event RefundedViaCctp(
        bytes32 indexed refundId, uint32 indexed destinationDomain, bytes32 mintRecipient, uint256 amount
    );
    event ReleaseQueued(
        bytes32 indexed redemptionId, address indexed token, address indexed to, uint256 amount, uint256 executeAfter
    );
    event CctpSet(
        address previousTokenMessenger,
        address previousMessageTransmitter,
        address previousUsdc,
        address tokenMessenger,
        address messageTransmitter,
        address usdc
    );

    function setUp() public {
        vault = new CompagesVault(owner, operator, guardian, DELAY);
        transmitter = new MockMessageTransmitterV2(0); // Ethereum is domain 0
        messenger = new MockTokenMessengerV2(transmitter);
        usdc = new BlocklistPausableERC20();
        messenger.addRemote(SOLANA, REMOTE_TM, SOL_USDC, address(usdc));
        messenger.addRemote(BASE, REMOTE_TM, bytes32(uint256(0xBA5E)), address(usdc));
        vm.prank(owner);
        vault.setCctp(address(messenger), address(transmitter), address(usdc));
    }

    // ------------------------------------------------------------------
    // message builders (Circle's MessageV2 / BurnMessageV2 layout)
    // ------------------------------------------------------------------

    function _message(
        uint32 sourceDomain,
        uint32 destinationDomain,
        bytes32 nonce,
        bytes32 sender,
        bytes32 recipient,
        bytes32 destinationCaller,
        uint32 minFinality,
        uint32 finalityExecuted,
        bytes memory body
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint32(1),
            sourceDomain,
            destinationDomain,
            nonce,
            sender,
            recipient,
            destinationCaller,
            minFinality,
            finalityExecuted,
            body
        );
    }

    function _burnBody(
        bytes32 burnToken,
        bytes32 mintRecipient,
        uint256 amount,
        bytes32 messageSender,
        uint256 maxFee,
        uint256 feeExecuted,
        uint256 expirationBlock,
        bytes memory hookData
    ) internal pure returns (bytes memory) {
        bytes memory head = abi.encodePacked(uint32(1), burnToken, mintRecipient, amount, messageSender);
        return abi.encodePacked(head, maxFee, feeExecuted, expirationBlock, hookData);
    }

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// An attested Solana -> Ethereum burn to the vault.
    function _inbound(bytes32 nonce, bytes32 destinationCaller, uint256 amount, uint256 fee, bytes memory hook)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = _burnBody(SOL_USDC, _b32(address(vault)), amount, SOL_SENDER, fee, fee, 0, hook);
        return _message(SOLANA, 0, nonce, REMOTE_TM, _b32(address(messenger)), destinationCaller, 2000, 2000, body);
    }

    function _depositHook(string memory seqAddr) internal pure returns (bytes memory) {
        return abi.encodePacked("compages:deposit:", seqAddr);
    }

    function _usdcLimit(uint256 capacity) internal {
        vm.prank(owner);
        vault.setReleaseLimit(address(usdc), capacity, capacity);
        vm.warp(block.timestamp + 1);
    }

    uint256 private _nonceSeq;

    function _depositViaCctp(uint256 amount) internal {
        bytes32 nonce = keccak256(abi.encode("deposit", ++_nonceSeq));
        bytes memory m = _inbound(nonce, _b32(address(vault)), amount, 0, _depositHook(SEQ_ADDR));
        vm.prank(relayer);
        vault.receiveCctp(m, ATTESTATION);
    }

    // ------------------------------------------------------------------
    // layout fidelity
    // ------------------------------------------------------------------

    /// A real CCTP V2 message emitted by Circle's MessageTransmitterV2 on
    /// Sepolia (tx 0x21d937c9...; Ethereum -> domain 26). Building it from its
    /// fields must reproduce it byte for byte, which pins the offsets the
    /// vault and the mocks use.
    function test_layout_matchesARealSepoliaMessage() public pure {
        bytes memory real =
            hex"00000001000000000000001a00000000000000000000000000000000000000000000000000000000000000000000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000003e800000000000000010000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000007afafb1169c2f2edaaa138dbc6ef4a01041e08ec0000000000000000000000000000000000000000000000000000000000000052000000000000000000000000c5567a5e3370d4dbfb0540025078e283e36a363d000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
        bytes32 tm = bytes32(uint256(uint160(0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA)));
        bytes memory built = _message(
            0,
            26,
            bytes32(0),
            tm,
            tm,
            bytes32(0),
            1000,
            0,
            _burnBody(
                bytes32(uint256(uint160(0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238))),
                bytes32(uint256(uint160(0x7AFAFb1169c2f2EDAAa138dBC6Ef4a01041E08ec))),
                0x52,
                bytes32(uint256(uint160(0xC5567a5E3370d4DBfB0540025078e283e36A363d))),
                1,
                0,
                0,
                ""
            )
        );
        assertEq(real.length, 376);
        assertEq(built, real);
    }

    /// The mock messenger's outbound message has the same layout as Circle's.
    function test_layout_outboundBurnMessage() public {
        _depositViaCctp(1000e6);
        _usdcLimit(1000e6);
        bytes32 recipient = keccak256("solana-ata");
        vm.recordLogs();
        vm.prank(operator);
        vault.releaseViaCctp(100e6, SOLANA, recipient, keccak256("r"), 5);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory sent;
        for (uint256 i; i < logs.length; i++) {
            if (
                logs[i].emitter == address(transmitter)
                    && logs[i].topics[0] == MockMessageTransmitterV2.MessageSent.selector
            ) {
                sent = abi.decode(logs[i].data, (bytes));
            }
        }
        bytes memory expected = _message(
            0,
            SOLANA,
            bytes32(0),
            _b32(address(messenger)),
            REMOTE_TM,
            bytes32(0),
            2000,
            0,
            _burnBody(_b32(address(usdc)), recipient, 100e6, _b32(address(vault)), 5, 0, 0, "")
        );
        assertEq(sent, expected);
    }

    // ------------------------------------------------------------------
    // inbound deposits
    // ------------------------------------------------------------------

    function test_receive_deposit_relayedByAnyone() public {
        // A direct deposit first, so the CCTP one shares the same counter.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vault.depositEther{value: 1 ether}(SEQ_ADDR);

        bytes32 cctpNonce = keccak256("n1");
        // 100 USDC burned with a 0.25 fee executed: 99.75 arrives.
        bytes memory m = _inbound(cctpNonce, _b32(address(vault)), 100e6, 0.25e6, _depositHook(SEQ_ADDR));
        vm.expectEmit(true, true, true, true, address(vault));
        emit Deposited(1, address(usdc), address(0), 99.75e6, SEQ_ADDR);
        vm.expectEmit(true, true, true, true, address(vault));
        emit CctpDeposit(1, SOLANA, SOL_SENDER, cctpNonce, 99.75e6);
        vm.prank(relayer);
        vault.receiveCctp(m, ATTESTATION);

        assertEq(vault.depositCount(), 2);
        assertEq(usdc.balanceOf(address(vault)), 99.75e6);
        assertEq(usdc.balanceOf(messenger.feeRecipient()), 0.25e6);
    }

    function test_receive_rebalance_emitsRebalancedInOnly() public {
        bytes memory m = _inbound(keccak256("n2"), _b32(address(vault)), 50e6, 0, "compages:rebalance");
        vm.recordLogs();
        vm.prank(relayer);
        vault.receiveCctp(m, ATTESTATION);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            seen++;
            assertEq(logs[i].topics[0], RebalancedIn.selector);
            assertEq(logs[i].topics[1], _b32(address(usdc)));
            assertEq(logs[i].topics[2], bytes32(uint256(SOLANA)));
            (uint256 amount, bytes32 sender) = abi.decode(logs[i].data, (uint256, bytes32));
            assertEq(amount, 50e6);
            assertEq(sender, SOL_SENDER);
        }
        assertEq(seen, 1);
        assertEq(vault.depositCount(), 0);
        assertEq(usdc.balanceOf(address(vault)), 50e6);
    }

    function test_receive_unfinalizedFastTransferIsAccepted() public {
        bytes memory m = _message(
            SOLANA,
            0,
            keccak256("fast"),
            REMOTE_TM,
            _b32(address(messenger)),
            _b32(address(vault)),
            1000,
            1000,
            _burnBody(SOL_USDC, _b32(address(vault)), 10e6, SOL_SENDER, 1e4, 1e4, 0, _depositHook(SEQ_ADDR))
        );
        vm.prank(relayer);
        vault.receiveCctp(m, ATTESTATION);
        assertEq(usdc.balanceOf(address(vault)), 10e6 - 1e4);
    }

    function _toAlice(bytes32 nonce, uint256 fee) internal view returns (bytes memory) {
        bytes memory body = _burnBody(SOL_USDC, _b32(alice), 10e6, SOL_SENDER, fee, fee, 0, _depositHook(SEQ_ADDR));
        return _message(SOLANA, 0, nonce, REMOTE_TM, _b32(address(messenger)), _b32(address(vault)), 2000, 2000, body);
    }

    /// A burn that names the vault as destinationCaller but mints to someone
    /// else can only be completed by the vault: it is relayed, not stranded.
    function test_receive_otherMintRecipient_isForwarded() public {
        _depositViaCctp(50e6);
        uint256 countBefore = vault.depositCount();
        bytes memory m = _toAlice(keccak256("n3"), 0);
        vm.expectRevert("Invalid caller for message");
        transmitter.receiveMessage(m, ATTESTATION);

        vm.recordLogs();
        vm.prank(relayer);
        vault.receiveCctp(m, ATTESTATION);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(usdc.balanceOf(alice), 10e6);
        assertEq(usdc.balanceOf(address(vault)), 50e6);
        assertEq(vault.depositCount(), countBefore);
        uint256 seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            seen++;
            assertEq(logs[i].topics[0], CctpForwarded.selector);
            assertEq(logs[i].topics[1], bytes32(uint256(SOLANA)));
            assertEq(logs[i].topics[2], _b32(alice));
            assertEq(abi.decode(logs[i].data, (bytes32)), keccak256("n3"));
        }
        assertEq(seen, 1);

        // Forwarding does not bypass the transmitter's replay guard.
        vm.expectRevert("Nonce already used");
        vault.receiveCctp(m, ATTESTATION);
    }

    function test_receive_forwardMustNotMoveVaultFunds() public {
        _depositViaCctp(50e6);
        // Circle's fee on the forwarded mint would land in the vault.
        messenger.setFeeRecipient(address(vault));
        bytes memory m = _toAlice(keccak256("fee"), 1e6);
        vm.expectRevert(CompagesVault.CctpBadMessage.selector);
        vault.receiveCctp(m, ATTESTATION);
        assertEq(usdc.balanceOf(address(vault)), 50e6);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_receive_forwardWorksWhileDepositsPaused() public {
        vm.prank(guardian);
        vault.pauseDeposits();
        vault.receiveCctp(_toAlice(keccak256("p"), 0), ATTESTATION);
        assertEq(usdc.balanceOf(alice), 10e6);
    }

    function test_receive_messageNotForTheTokenMessengerReverts() public {
        bytes memory m = _message(
            SOLANA,
            0,
            keccak256("n4"),
            REMOTE_TM,
            _b32(alice),
            bytes32(0),
            2000,
            2000,
            _burnBody(SOL_USDC, _b32(address(vault)), 10e6, SOL_SENDER, 0, 0, 0, _depositHook(SEQ_ADDR))
        );
        vm.prank(relayer);
        vm.expectRevert(CompagesVault.CctpBadMessage.selector);
        vault.receiveCctp(m, ATTESTATION);
    }

    function test_receive_truncatedMessageReverts() public {
        bytes memory full = _inbound(keccak256("n5"), bytes32(0), 10e6, 0, "");
        bytes memory short = new bytes(375);
        for (uint256 i; i < 375; i++) {
            short[i] = full[i];
        }
        vm.expectRevert(CompagesVault.CctpBadMessage.selector);
        vault.receiveCctp(short, ATTESTATION);
    }

    function test_receive_destinationCallerSemantics() public {
        // Addressed to the vault: only the vault can complete it.
        bytes memory toVault = _inbound(keccak256("dc1"), _b32(address(vault)), 10e6, 0, _depositHook(SEQ_ADDR));
        vm.prank(relayer);
        vm.expectRevert("Invalid caller for message");
        transmitter.receiveMessage(toVault, ATTESTATION);
        vm.prank(relayer);
        vault.receiveCctp(toVault, ATTESTATION);

        // Addressed to someone else: the vault cannot complete it.
        bytes memory toOther = _inbound(keccak256("dc2"), _b32(relayer), 10e6, 0, _depositHook(SEQ_ADDR));
        vm.expectRevert("Invalid caller for message");
        vault.receiveCctp(toOther, ATTESTATION);

        // Open to any caller: the vault completes it if it gets there first.
        bytes memory open = _inbound(keccak256("dc3"), bytes32(0), 10e6, 0, _depositHook(SEQ_ADDR));
        vault.receiveCctp(open, ATTESTATION);
        assertEq(vault.depositCount(), 2);
    }

    function test_receive_replayReverts() public {
        bytes memory m = _inbound(keccak256("n6"), _b32(address(vault)), 10e6, 0, _depositHook(SEQ_ADDR));
        vault.receiveCctp(m, ATTESTATION);
        vm.expectRevert("Nonce already used");
        vault.receiveCctp(m, ATTESTATION);
        assertEq(vault.depositCount(), 1);
    }

    function test_receive_badAttestationReverts() public {
        bytes memory m = _inbound(keccak256("n7"), _b32(address(vault)), 10e6, 0, _depositHook(SEQ_ADDR));
        vm.expectRevert("Invalid attestation");
        vault.receiveCctp(m, "forged");
    }

    function test_receive_unrecognizedHookData_isKeptAndReported() public {
        bytes[5] memory bad = [
            bytes(""),
            bytes("compages:deposit"),
            bytes("compages:rebalance "),
            bytes("COMPAGES:DEPOSIT:tex1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty"),
            bytes("something else entirely")
        ];
        for (uint256 i; i < bad.length; i++) {
            bytes32 nonce = keccak256(abi.encode("bad", i));
            bytes memory m = _inbound(nonce, _b32(address(vault)), 10e6, 0, bad[i]);
            vm.expectEmit(true, true, true, true, address(vault));
            emit CctpUnrecognized(SOLANA, SOL_SENDER, nonce, 10e6, bad[i]);
            vault.receiveCctp(m, ATTESTATION);
        }
        assertEq(vault.depositCount(), 0);
        assertEq(usdc.balanceOf(address(vault)), 50e6);
    }

    function test_receive_depositAddressLengthBounds() public {
        bytes memory a13 = new bytes(13);
        bytes memory a14 = new bytes(14);
        bytes memory a120 = new bytes(120);
        bytes memory a121 = new bytes(121);
        bytes memory m;
        // Out-of-bounds addresses are not deposits: kept and reported instead.
        m = _inbound(keccak256("l13"), bytes32(0), 1e6, 0, abi.encodePacked("compages:deposit:", a13));
        vm.expectEmit(true, true, true, true, address(vault));
        emit CctpUnrecognized(SOLANA, SOL_SENDER, keccak256("l13"), 1e6, abi.encodePacked("compages:deposit:", a13));
        vault.receiveCctp(m, ATTESTATION);
        m = _inbound(keccak256("l121"), bytes32(0), 1e6, 0, abi.encodePacked("compages:deposit:", a121));
        vault.receiveCctp(m, ATTESTATION);
        vault.receiveCctp(
            _inbound(keccak256("l14"), bytes32(0), 1e6, 0, abi.encodePacked("compages:deposit:", a14)), ATTESTATION
        );
        vault.receiveCctp(
            _inbound(keccak256("l120"), bytes32(0), 1e6, 0, abi.encodePacked("compages:deposit:", a120)), ATTESTATION
        );
        assertEq(vault.depositCount(), 2);
    }

    function test_receive_depositsPaused_revertsButRebalanceStillLands() public {
        vm.prank(guardian);
        vault.pauseDeposits();
        bytes memory dep = _inbound(keccak256("p1"), _b32(address(vault)), 10e6, 0, _depositHook(SEQ_ADDR));
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.receiveCctp(dep, ATTESTATION);
        // The message is still unused and can be relayed after unpausing.
        assertEq(transmitter.usedNonces(keccak256("p1")), 0);

        vault.receiveCctp(_inbound(keccak256("p2"), _b32(address(vault)), 5e6, 0, "compages:rebalance"), ATTESTATION);
        assertEq(usdc.balanceOf(address(vault)), 5e6);

        vm.prank(owner);
        vault.unpauseDeposits();
        vault.receiveCctp(dep, ATTESTATION);
        assertEq(vault.depositCount(), 1);
    }

    function test_receive_depositRulesDoNotApply() public {
        vm.startPrank(owner);
        vault.setMinDeposit(address(usdc), 1000e6);
        vault.setDepositCap(address(usdc), 1);
        vault.setTokenBlocked(address(usdc), true);
        vm.stopPrank();
        vault.receiveCctp(_inbound(keccak256("r1"), bytes32(0), 5e6, 0, _depositHook(SEQ_ADDR)), ATTESTATION);
        assertEq(vault.depositCount(), 1);
    }

    function test_receive_unsupportedBurnTokenReverts() public {
        bytes memory m = _message(
            SOLANA,
            0,
            keccak256("u1"),
            REMOTE_TM,
            _b32(address(messenger)),
            bytes32(0),
            2000,
            2000,
            _burnBody(keccak256("not-usdc"), _b32(address(vault)), 10e6, SOL_SENDER, 0, 0, 0, _depositHook(SEQ_ADDR))
        );
        vm.expectRevert("Mint token not supported");
        vault.receiveCctp(m, ATTESTATION);
    }

    function test_receive_mintOfAnotherTokenCreditsNothing() public {
        // The remote token maps to some local token other than our USDC.
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        bytes32 remoteOther = keccak256("remote-other");
        messenger.addRemote(SOLANA, REMOTE_TM, remoteOther, address(other));
        bytes memory m = _message(
            SOLANA,
            0,
            keccak256("o1"),
            REMOTE_TM,
            _b32(address(messenger)),
            bytes32(0),
            2000,
            2000,
            _burnBody(remoteOther, _b32(address(vault)), 10e6, SOL_SENDER, 0, 0, 0, _depositHook(SEQ_ADDR))
        );
        vm.expectRevert(CompagesVault.CctpNothingMinted.selector);
        vault.receiveCctp(m, ATTESTATION);
    }

    function test_receive_disabled() public {
        vm.prank(owner);
        vault.setCctp(address(0), address(0), address(0));
        bytes memory m = _inbound(keccak256("d1"), bytes32(0), 10e6, 0, _depositHook(SEQ_ADDR));
        vm.expectRevert(CompagesVault.CctpDisabled.selector);
        vault.receiveCctp(m, ATTESTATION);
    }

    // ------------------------------------------------------------------
    // outbound
    // ------------------------------------------------------------------

    function test_releaseViaCctp_burnsNow() public {
        _depositViaCctp(1000e6);
        _usdcLimit(500e6);
        bytes32 id = keccak256("redeem-to-solana");
        bytes32 ata = keccak256("solana-ata");
        vm.expectEmit(true, true, true, true, address(vault));
        emit ReleasedViaCctp(id, SOLANA, ata, 200e6);
        vm.prank(operator);
        vault.releaseViaCctp(200e6, SOLANA, ata, id, 1e6);

        assertTrue(vault.processedRedemptions(id));
        assertEq(usdc.balanceOf(address(vault)), 800e6);
        assertEq(messenger.lastAllowance(), 200e6); // approved exactly the amount
        assertEq(usdc.allowance(address(vault), address(messenger)), 0); // and reset
        assertEq(messenger.lastAmount(), 200e6);
        assertEq(messenger.lastDestinationDomain(), SOLANA);
        assertEq(messenger.lastMintRecipient(), ata);
        assertEq(messenger.lastDestinationCaller(), bytes32(0));
        assertEq(messenger.lastMaxFee(), 1e6);
        assertEq(messenger.lastMinFinality(), 2000);
        assertEq(vault.availableToRelease(address(usdc)), 300e6);
    }

    function test_refundViaCctp_emitsRefundedViaCctp() public {
        _depositViaCctp(100e6);
        _usdcLimit(500e6);
        bytes32 id = keccak256("compages:refund:cctp");
        vm.recordLogs();
        vm.prank(operator);
        vault.refundViaCctp(100e6, SOLANA, SOL_SENDER, id, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 refunded;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            assertTrue(logs[i].topics[0] != ReleasedViaCctp.selector);
            if (logs[i].topics[0] == RefundedViaCctp.selector) refunded++;
        }
        assertEq(refunded, 1);
    }

    function test_releaseViaCctp_queuesOverLimit_thenExecutes() public {
        _depositViaCctp(1000e6);
        _usdcLimit(100e6);
        bytes32 id = keccak256("big");
        bytes32 ata = keccak256("base-recipient");
        uint256 due = block.timestamp + DELAY;
        vm.expectEmit(true, true, true, true, address(vault));
        emit ReleaseQueued(id, address(usdc), address(0), 300e6, due);
        vm.prank(operator);
        vault.releaseViaCctp(300e6, BASE, ata, id, 7);

        (bool viaCctp, uint32 domain, bytes32 recipient, uint256 maxFee) = vault.queuedCctpRelease(id);
        assertTrue(viaCctp);
        assertEq(domain, BASE);
        assertEq(recipient, ata);
        assertEq(maxFee, 7);
        (address t, address to, uint256 amount,,,) = vault.queuedRelease(id);
        assertEq(t, address(usdc));
        assertEq(to, address(0));
        assertEq(amount, 300e6);
        assertEq(vault.queuedTotal(address(usdc)), 300e6);

        vm.expectRevert(abi.encodeWithSelector(CompagesVault.ReleaseNotReady.selector, due));
        vault.executeRelease(id);
        vm.warp(due);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ReleasedViaCctp(id, BASE, ata, 300e6);
        vm.prank(relayer);
        vault.executeRelease(id);
        assertEq(usdc.balanceOf(address(vault)), 700e6);
        assertEq(messenger.lastMaxFee(), 7);
        assertEq(usdc.allowance(address(vault), address(messenger)), 0);
        assertEq(vault.queuedTotal(address(usdc)), 0);
    }

    function test_refundViaCctp_queuedExecutesAsRefund() public {
        _depositViaCctp(1000e6);
        bytes32 id = keccak256("refund-q");
        vm.prank(operator);
        vault.refundViaCctp(10e6, SOLANA, SOL_SENDER, id, 0); // USDC bucket unconfigured: queued
        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(true, true, true, true, address(vault));
        emit RefundedViaCctp(id, SOLANA, SOL_SENDER, 10e6);
        vault.executeRelease(id);
    }

    function test_releaseViaCctp_cancelReinstate() public {
        _depositViaCctp(1000e6);
        bytes32 id = keccak256("cr");
        vm.prank(operator);
        vault.releaseViaCctp(10e6, SOLANA, SOL_SENDER, id, 0);
        vm.prank(guardian);
        vault.cancelRelease(id);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(CompagesVault.NotQueued.selector);
        vault.executeRelease(id);
        vm.prank(owner);
        vault.reinstateRelease(id);
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(id);
        assertEq(usdc.balanceOf(address(vault)), 990e6);
    }

    function test_releaseViaCctp_sharesReplayMapWithRelease() public {
        _depositViaCctp(1000e6);
        _usdcLimit(1000e6);
        bytes32 id = keccak256("shared");
        vm.startPrank(operator);
        vault.release(address(usdc), payable(alice), 1e6, id);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, id, 0);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.refundViaCctp(1e6, SOLANA, SOL_SENDER, id, 0);
        vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("other"), 0);
        vm.expectRevert(CompagesVault.AlreadyReleased.selector);
        vault.release(address(usdc), payable(alice), 1e6, keccak256("other"));
        vm.stopPrank();
    }

    function test_releaseViaCctp_respectsPause() public {
        _depositViaCctp(1000e6);
        _usdcLimit(1000e6);
        vm.prank(guardian);
        vault.pauseReleases();
        vm.startPrank(operator);
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("p"), 0);
        vm.expectRevert(CompagesVault.ReleasesArePaused.selector);
        vault.refundViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("p"), 0);
        vm.stopPrank();
    }

    function test_releaseViaCctp_respectsOwed() public {
        _depositViaCctp(100e6);
        _usdcLimit(1000e6);
        usdc.setBlocklisted(alice, true);
        vm.prank(operator);
        vault.release(address(usdc), payable(alice), 60e6, keccak256("owed"));
        assertEq(vault.owedTotal(address(usdc)), 60e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(CompagesVault.InsufficientVaultBalance.selector, address(usdc), 50e6, 40e6)
        );
        vault.releaseViaCctp(50e6, SOLANA, SOL_SENDER, keccak256("x"), 0);
        vm.prank(operator);
        vault.releaseViaCctp(40e6, SOLANA, SOL_SENDER, keccak256("x"), 0);
    }

    function test_releaseViaCctp_inputChecksAndAccess() public {
        _depositViaCctp(100e6);
        _usdcLimit(1000e6);
        vm.startPrank(operator);
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.releaseViaCctp(1e6, SOLANA, bytes32(0), keccak256("a"), 0);
        vm.expectRevert(CompagesVault.ZeroAmount.selector);
        vault.releaseViaCctp(0, SOLANA, SOL_SENDER, keccak256("a"), 0);
        vm.expectRevert(CompagesVault.MaxFeeTooHigh.selector);
        vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("a"), 1e6);
        vm.stopPrank();
        assertFalse(vault.processedRedemptions(keccak256("a")));

        address[3] memory others = [owner, guardian, alice];
        for (uint256 i; i < others.length; i++) {
            vm.startPrank(others[i]);
            vm.expectRevert(CompagesVault.NotOperator.selector);
            vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("b"), 0);
            vm.expectRevert(CompagesVault.NotOperator.selector);
            vault.refundViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("b"), 0);
            vm.stopPrank();
        }
    }

    function test_releaseViaCctp_messengerFailureReverts() public {
        _depositViaCctp(100e6);
        _usdcLimit(1000e6);
        // No TokenMessenger registered for domain 99: Circle reverts, and so
        // does the release, leaving the id unused.
        vm.prank(operator);
        vm.expectRevert("No TokenMessenger for domain");
        vault.releaseViaCctp(1e6, 99, SOL_SENDER, keccak256("m"), 0);
        assertFalse(vault.processedRedemptions(keccak256("m")));
    }

    function test_releaseViaCctp_disabled() public {
        _depositViaCctp(100e6);
        bytes32 id = keccak256("q");
        vm.prank(operator);
        vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, id, 0); // queued
        vm.prank(owner);
        vault.setCctp(address(0), address(0), address(0));
        vm.prank(operator);
        vm.expectRevert(CompagesVault.CctpDisabled.selector);
        vault.releaseViaCctp(1e6, SOLANA, SOL_SENDER, keccak256("r"), 0);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(CompagesVault.CctpDisabled.selector);
        vault.executeRelease(id);
    }

    // ------------------------------------------------------------------
    // configuration and hand-off
    // ------------------------------------------------------------------

    function test_setCctp_validationAndAccess() public {
        vm.prank(operator);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setCctp(address(0), address(0), address(0));
        vm.prank(guardian);
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vault.setCctp(address(0), address(0), address(0));

        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.CctpMisconfigured.selector);
        vault.setCctp(address(messenger), address(0), address(usdc));
        vm.expectRevert(CompagesVault.CctpMisconfigured.selector);
        vault.setCctp(address(messenger), address(transmitter), address(0));
        vm.expectRevert(CompagesVault.CctpMisconfigured.selector);
        vault.setCctp(address(messenger), address(0xDEAD), address(usdc));

        vm.expectEmit(true, true, true, true, address(vault));
        emit CctpSet(address(messenger), address(transmitter), address(usdc), address(0), address(0), address(0));
        vault.setCctp(address(0), address(0), address(0));
        vm.stopPrank();
        assertEq(vault.cctpUsdc(), address(0));
    }

    function test_constants() public view {
        assertEq(vault.CCTP_DEPOSIT_TAG(), bytes("compages:deposit:"));
        assertEq(vault.CCTP_REBALANCE_TAG(), bytes("compages:rebalance"));
        assertEq(vault.CCTP_FINALITY_FINALIZED(), 2000);
    }

    function test_burnLockedUSDC_withCctpEscrow_sparesOwedAndQueued() public {
        _depositViaCctp(1000e6);
        vault.receiveCctp(_inbound(keccak256("rb"), bytes32(0), 500e6, 0, "compages:rebalance"), ATTESTATION);
        _usdcLimit(100e6);
        usdc.setBlocklisted(alice, true);
        vm.startPrank(operator);
        vault.release(address(usdc), payable(alice), 100e6, keccak256("owed")); // owed 100
        vault.releaseViaCctp(250e6, SOLANA, SOL_SENDER, keccak256("queued"), 0); // queued 250
        vm.stopPrank();
        usdc.setBlocklisted(alice, false);

        address circle = makeAddr("circle-burner");
        vm.startPrank(owner);
        vault.setStablecoinBurner(address(usdc), circle);
        vault.pauseDeposits();
        vault.pauseReleases();
        vm.stopPrank();
        vm.prank(circle);
        vault.burnLockedUSDC();
        // 1500 held - 100 owed - 250 queued = 1150 burned.
        assertEq(usdc.balanceOf(address(vault)), 350e6);
    }

    // ------------------------------------------------------------------
    // regressions from review
    // ------------------------------------------------------------------

    /// A burn addressed to the vault with a malformed deposit tag used to be
    /// unreceivable forever (only the vault may relay it). It now lands, is
    /// reported, and can be refunded to its sender.
    function test_regression_badHookIsRefundable() public {
        bytes memory longAddr = new bytes(121);
        for (uint256 i; i < 121; i++) {
            longAddr[i] = "a";
        }
        bytes memory hook = abi.encodePacked("compages:deposit:", longAddr);
        bytes memory m = _inbound(keccak256("n1"), _b32(address(vault)), 100e6, 0, hook);
        vm.expectRevert(bytes("Invalid caller for message"));
        transmitter.receiveMessage(m, ATTESTATION);

        vm.expectEmit(true, true, true, true, address(vault));
        emit CctpUnrecognized(SOLANA, SOL_SENDER, keccak256("n1"), 100e6, hook);
        vm.prank(relayer);
        vault.receiveCctp(m, ATTESTATION);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
        assertEq(vault.depositCount(), 0);

        _usdcLimit(1000e6);
        vm.prank(operator);
        vault.refundViaCctp(100e6, SOLANA, SOL_SENDER, keccak256("refund-n1"), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(messenger.lastMintRecipient(), SOL_SENDER);
    }

    function test_regression_N3_unrecognizedWaitsOutADepositPause() public {
        address burner = makeAddr("burner");
        vm.startPrank(owner);
        vault.setStablecoinBurner(address(usdc), burner);
        vault.pauseDeposits();
        vault.pauseReleases();
        vm.stopPrank();
        bytes memory m = _inbound(keccak256("u"), _b32(address(vault)), 70e6, 0, bytes("compages:deposit:short"));
        vm.expectRevert(CompagesVault.DepositsArePaused.selector);
        vault.receiveCctp(m, ATTESTATION);
        assertEq(transmitter.usedNonces(keccak256("u")), 0); // still relayable
        assertEq(usdc.balanceOf(address(vault)), 0);

        // After the lock it lands and is reported for a refund.
        vm.prank(owner);
        vault.unpauseDeposits();
        vault.receiveCctp(m, ATTESTATION);
        assertEq(usdc.balanceOf(address(vault)), 70e6);
    }

    function test_amendCancelledRelease_cctp() public {
        _depositViaCctp(100e6);
        bytes32 id = keccak256("stranded");
        // Queued to a domain with no TokenMessenger: execution would revert forever.
        vm.prank(operator);
        vault.releaseViaCctp(40e6, 99, SOL_SENDER, id, 0);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert("No TokenMessenger for domain");
        vault.executeRelease(id);

        vm.prank(guardian);
        vault.cancelRelease(id);
        vm.startPrank(owner);
        vm.expectRevert(CompagesVault.InvalidRecipient.selector);
        vault.amendCancelledRelease(id, true, address(0), SOLANA, bytes32(0), 0);
        vm.expectRevert(CompagesVault.MaxFeeTooHigh.selector);
        vault.amendCancelledRelease(id, true, address(0), SOLANA, SOL_SENDER, 40e6);
        vm.expectEmit(true, true, true, true, address(vault));
        emit ReleaseAmended(id, true, address(0), SOLANA, SOL_SENDER, 1e6);
        vault.amendCancelledRelease(id, true, alice, SOLANA, SOL_SENDER, 1e6); // `to` is ignored for CCTP
        (, address to,,,,) = vault.queuedRelease(id);
        assertEq(to, address(0));
        vault.reinstateRelease(id);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(id);
        assertEq(messenger.lastDestinationDomain(), SOLANA);
        assertEq(messenger.lastMaxFee(), 1e6);
        assertEq(usdc.balanceOf(address(vault)), 60e6);
    }

    function test_amendCancelledRelease_cctpToDirect() public {
        _depositViaCctp(100e6);
        bytes32 id = keccak256("to-direct");
        vm.prank(operator);
        vault.releaseViaCctp(40e6, 99, SOL_SENDER, id, 0);
        vm.prank(guardian);
        vault.cancelRelease(id);
        vm.startPrank(owner);
        vault.amendCancelledRelease(id, false, alice, 0, bytes32(0), 0);
        vault.reinstateRelease(id);
        vm.stopPrank();
        vm.warp(block.timestamp + DELAY);
        vault.executeRelease(id);
        assertEq(usdc.balanceOf(alice), 40e6);
    }
}
