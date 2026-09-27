// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CompagesVault} from "../../src/CompagesVault.sol";
import {SafeOwner, SafeV141, ISafe} from "../../script/SafeOwner.s.sol";

/// Rehearses moving the vault's owner role to a Safe v1.4.1 multisig, against
/// the vault as it is deployed on Sepolia and the canonical Safe contracts
/// there, on a local fork. Nothing is broadcast: the current owner is
/// impersonated and the Safe's signers are throwaway test keys.
///
/// The steps run through script/SafeOwner.s.sol itself, the script the owner
/// runs for real, so the rehearsal exercises the same code:
/// deploySafe (2-of-3), proposeSafe (the current owner's transferOwnership),
/// acceptTx (the printed safeTxHash) and execAccept (the signatures, in any
/// order and in both raw and eth_sign form). It then proves the Safe is the
/// owner and the only owner, that the guardian and operator keep exactly
/// their powers, and that the Safe can hand ownership back to a single key.
///
/// Skipped unless REHEARSAL_RPC_URL is set, so a plain `forge test` stays
/// offline. contrib/safe-owner-rehearsal.sh sets it and runs this with -vv,
/// which prints the transcript.
///
/// Environment (all optional but the URL):
///   REHEARSAL_RPC_URL  Sepolia RPC to fork
///   FORK_BLOCK         pin the fork to a block (default: latest)
///   VAULT              vault address (default: the live Sepolia vault)
contract SafeOwnerRehearsal is Test {
    address constant LIVE_VAULT = 0x7B702D6A2E2351F0c4E549642e65AbABC0324384;

    CompagesVault vault;
    SafeOwner script;
    address owner;
    address guardian;
    address operator;

    address signer1;
    uint256 key1;
    address signer2;
    uint256 key2;
    address signer3;
    uint256 key3;

    function setUp() public {
        string memory url = vm.envOr("REHEARSAL_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true, "REHEARSAL_RPC_URL not set; run contrib/safe-owner-rehearsal.sh");
            return;
        }
        uint256 forkBlock = vm.envOr("FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);

        vault = CompagesVault(vm.envOr("VAULT", LIVE_VAULT));
        vm.setEnv("VAULT", vm.toString(address(vault)));
        owner = vault.owner();
        guardian = vault.guardian();
        operator = vault.operator();
        (signer1, key1) = makeAddrAndKey("safe-signer-1");
        (signer2, key2) = makeAddrAndKey("safe-signer-2");
        (signer3, key3) = makeAddrAndKey("safe-signer-3");
        script = new SafeOwner();
    }

    function test_moveOwnerToSafeAndBack() public {
        _title("Owner to Safe rehearsal");
        console.log("fork block        ", block.number);
        console.log("chain id          ", block.chainid);
        console.log("vault             ", address(vault));
        console.log("vault VERSION     ", vault.VERSION());
        console.log("owner             ", owner);
        console.log("guardian          ", guardian);
        console.log("operator          ", operator);
        assertEq(vault.pendingOwner(), address(0), "no ownership transfer in progress");
        SafeV141.checkCanonical();
        _ok("canonical SafeL2, SafeProxyFactory and fallback handler 1.4.1 present (code hashes match)");

        address safe = _deploy();
        _propose(safe);
        _accept(safe);
        _ownerPowersMoved(safe);
        _rolesUntouched(safe);
        _handBack(safe);
        _title("Rehearsal passed");
    }

    function _deploy() private returns (address safe) {
        // A Safe that counted the hot operator key toward the threshold
        // would merge the roles; the script refuses it.
        vm.setEnv("SAFE_OWNERS", string.concat(vm.toString(signer1), ",", vm.toString(operator)));
        vm.setEnv("SAFE_THRESHOLD", "2");
        vm.expectRevert(bytes("the vault operator (a hot key) cannot be a Safe owner"));
        script.deploySafe();
        _reverted("deploySafe with the operator as a signer", "refused");

        vm.setEnv(
            "SAFE_OWNERS", string.concat(vm.toString(signer1), ",", vm.toString(signer2), ",", vm.toString(signer3))
        );
        vm.setEnv("SAFE_THRESHOLD", "2");
        vm.setEnv("SAFE_SALT_NONCE", vm.toString(uint256(keccak256("compages:safe-owner-rehearsal"))));
        safe = script.deploySafe();
        _ok("deploySafe(): 2-of-3 SafeL2 proxy through the canonical factory");

        ISafe s = ISafe(safe);
        assertEq(s.getThreshold(), 2);
        address[] memory owners = s.getOwners();
        assertEq(owners.length, 3);
        assertTrue(s.isOwner(signer1) && s.isOwner(signer2) && s.isOwner(signer3));
        assertEq(s.VERSION(), "1.4.1");
        assertEq(address(uint160(uint256(vm.load(safe, bytes32(0))))), SafeV141.SINGLETON_L2, "singleton");
        assertEq(
            address(uint160(uint256(vm.load(safe, SafeV141.FALLBACK_HANDLER_SLOT)))),
            SafeV141.FALLBACK_HANDLER,
            "fallback handler"
        );
        assertEq(s.nonce(), 0);

        // Idempotent: a second run finds the same Safe and deploys nothing.
        assertEq(script.deploySafe(), safe, "same owners, threshold and salt give the same Safe");
        _ok("deploySafe() again: same address, nothing deployed");
        vm.setEnv("SAFE", vm.toString(safe));
    }

    function _propose(address safe) private {
        _title("Step 2: the current owner names the Safe");
        // The Safe cannot accept before it is named.
        vm.expectRevert(CompagesVault.NotPendingOwner.selector);
        vm.prank(safe);
        vault.acceptOwnership();
        _reverted("Safe      acceptOwnership() before being named", "NotPendingOwner");

        script.proposeSafe();
        _ok("owner     transferOwnership(safe) via proposeSafe()");
        assertEq(vault.pendingOwner(), safe);
        assertEq(vault.owner(), owner, "nothing changes hands until the Safe accepts");

        address[3] memory others = [signer1, operator, guardian];
        string[3] memory names = ["a signer ", "operator ", "guardian "];
        for (uint256 i; i < others.length; i++) {
            vm.expectRevert(CompagesVault.NotPendingOwner.selector);
            vm.prank(others[i]);
            vault.acceptOwnership();
            _reverted(string.concat(names[i], " acceptOwnership()"), "NotPendingOwner");
        }
    }

    function _accept(address safe) private {
        bytes32 h = script.acceptTx();
        bytes memory data = abi.encodeCall(CompagesVault.acceptOwnership, ());
        assertEq(h, ISafe(safe).getTransactionHash(address(vault), 0, data, 0, 0, 0, 0, address(0), address(0), 0));
        _ok("acceptTx(): safeTxHash equals the Safe's own getTransactionHash");

        // One signature is below the threshold.
        vm.setEnv("SAFE_SIGNATURES", _sig(key1, h));
        vm.expectRevert(bytes("fewer signatures than the Safe's threshold"));
        script.execAccept();
        _reverted("execAccept() with 1 of 2 signatures", "refused");
        vm.expectRevert(bytes("GS020"));
        ISafe(safe)
            .execTransaction(
                address(vault),
                0,
                data,
                0,
                0,
                0,
                0,
                address(0),
                payable(address(0)),
                abi.encodePacked(_sigBytes(key1, h))
            );
        _reverted("Safe      execTransaction with 1 of 2 signatures", "GS020");

        // A stranger's signature does not count.
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        vm.setEnv("SAFE_SIGNATURES", string.concat(_sig(key1, h), ",", _sig(strangerKey, h)));
        vm.expectRevert(bytes("a signature is not an owner's over this Safe tx hash"));
        script.execAccept();
        _reverted("execAccept() with a stranger's signature", "refused");

        // Two owners, out of address order, one raw and one eth_sign.
        vm.setEnv("SAFE_SIGNATURES", string.concat(_ethSign(key3, h), ",", _sig(key1, h)));
        vm.expectEmit(address(vault));
        emit CompagesVault.OwnershipTransferred(owner, safe);
        script.execAccept();
        _ok("execAccept(): 2 of 3 signatures, acceptOwnership() executed by the Safe");
        assertEq(vault.owner(), safe, "the Safe owns the vault");
        assertEq(vault.pendingOwner(), address(0));
        assertEq(ISafe(safe).nonce(), 1);

        // The same signatures cannot be replayed: the nonce moved on.
        _replayReverts(safe, data, h);
        _reverted("Safe      replay of the executed signatures", "nonce consumed");
    }

    function _replayReverts(address safe, bytes memory data, bytes32 h) private {
        bytes memory sigs = _packSorted(key1, key3, h);
        vm.expectRevert();
        ISafe(safe).execTransaction(address(vault), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _ownerPowersMoved(address safe) private {
        _title("The Safe holds the owner's powers, and only the Safe does");
        uint256 delay = vault.releaseDelay();
        uint256 newDelay = delay + 1 hours <= vault.MAX_RELEASE_DELAY() ? delay + 1 hours : delay - 1 hours;

        vm.expectRevert(CompagesVault.NotOwner.selector);
        vm.prank(owner);
        vault.setReleaseDelay(newDelay);
        _reverted("old owner setReleaseDelay()", "NotOwner");
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vm.prank(owner);
        vault.transferOwnership(owner);
        _reverted("old owner transferOwnership(itself)", "NotOwner");
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vm.prank(signer1);
        vault.setReleaseDelay(newDelay);
        _reverted("a signer  setReleaseDelay() directly", "NotOwner");

        _safeCall(safe, abi.encodeCall(CompagesVault.setReleaseDelay, (newDelay)), key1, key2);
        assertEq(vault.releaseDelay(), newDelay);
        _ok(string.concat("Safe      setReleaseDelay(", vm.toString(newDelay), ") with 2 signatures"));
        _safeCall(safe, abi.encodeCall(CompagesVault.setReleaseDelay, (delay)), key2, key3);
        assertEq(vault.releaseDelay(), delay);
        _ok(string.concat("Safe      setReleaseDelay(", vm.toString(delay), ") back again"));
    }

    function _rolesUntouched(address safe) private {
        _title("The guardian and operator keep exactly their powers");
        assertEq(vault.guardian(), guardian, "guardian unchanged");
        assertEq(vault.operator(), operator, "operator unchanged");

        // The operator still releases. The fork's vault is given ether to pay
        // from; what it pays is within the ether bucket, or queued beyond it.
        vm.deal(address(vault), address(vault).balance + 1 ether);
        address payable to = payable(makeAddr("redeemer"));
        bytes32 id = keccak256("safe-owner-rehearsal:release");
        uint256 amount = 1e12;
        vm.prank(operator);
        vault.release(address(0), to, amount, id);
        assertTrue(vault.processedRedemptions(id));
        (,,,, CompagesVault.ReleaseState st,) = vault.queuedRelease(id);
        _ok(
            string.concat(
                "operator  release(ether, 0.000001) -> ", st == CompagesVault.ReleaseState.None ? "paid now" : "queued"
            )
        );
        vm.expectRevert(CompagesVault.NotOperator.selector);
        vm.prank(safe);
        vault.release(address(0), to, amount, keccak256("safe-owner-rehearsal:owner-release"));
        _reverted("Safe      release() (the owner is not the operator)", "NotOperator");

        // The guardian still pauses, alone; only the owner, now the Safe,
        // resumes.
        vm.prank(guardian);
        vault.pauseDeposits();
        vm.prank(guardian);
        vault.pauseReleases();
        assertTrue(vault.depositsPaused() && vault.releasesPaused());
        _ok("guardian  pauseDeposits() and pauseReleases(), one key, no signatures");
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vm.prank(guardian);
        vault.unpauseReleases();
        _reverted("guardian  unpauseReleases()", "NotOwner");
        vm.expectRevert(CompagesVault.NotOwner.selector);
        vm.prank(owner);
        vault.unpauseReleases();
        _reverted("old owner unpauseReleases()", "NotOwner");
        _safeCall(safe, abi.encodeCall(CompagesVault.unpauseReleases, ()), key1, key3);
        _safeCall(safe, abi.encodeCall(CompagesVault.unpauseDeposits, ()), key1, key3);
        assertFalse(vault.depositsPaused() || vault.releasesPaused());
        _ok("Safe      unpauseReleases() and unpauseDeposits()");
    }

    function _handBack(address safe) private {
        _title("Reversible: the Safe hands ownership back to a single key");
        vm.setEnv("NEW_OWNER", vm.toString(owner));
        bytes32 h = script.handBackTx();
        vm.setEnv("SAFE_SIGNATURES", string.concat(_sig(key2, h), ",", _sig(key3, h)));
        script.execHandBack();
        _ok("Safe      transferOwnership(original owner) via execHandBack()");
        assertEq(vault.owner(), safe, "the Safe owns the vault until the key accepts");
        assertEq(vault.pendingOwner(), owner);

        vm.prank(owner);
        vault.acceptOwnership();
        _ok("owner     acceptOwnership()");
        assertEq(vault.owner(), owner, "back with the original owner");
        assertEq(vault.pendingOwner(), address(0));

        uint256 delay = vault.releaseDelay();
        vm.prank(owner);
        vault.setReleaseDelay(delay);
        _ok("owner     setReleaseDelay() works again from the key");
        _safeCallReverts(safe, abi.encodeCall(CompagesVault.setReleaseDelay, (delay)), key1, key2);
        _reverted("Safe      setReleaseDelay() after handing back", "GS013 (NotOwner inside)");
        assertEq(vault.guardian(), guardian);
        assertEq(vault.operator(), operator);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _txHash(address safe, bytes memory data) private view returns (bytes32) {
        return ISafe(safe)
            .getTransactionHash(address(vault), 0, data, 0, 0, 0, 0, address(0), address(0), ISafe(safe).nonce());
    }

    function _safeCall(address safe, bytes memory data, uint256 ka, uint256 kb) private {
        bytes32 h = _txHash(safe, data);
        assertTrue(
            ISafe(safe)
                .execTransaction(
                    address(vault), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), _packSorted(ka, kb, h)
                )
        );
    }

    function _safeCallReverts(address safe, bytes memory data, uint256 ka, uint256 kb) private {
        bytes32 h = _txHash(safe, data);
        bytes memory sigs = _packSorted(ka, kb, h);
        vm.expectRevert(bytes("GS013"));
        ISafe(safe).execTransaction(address(vault), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
    }

    function _sigBytes(uint256 key, bytes32 h) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _packSorted(uint256 ka, uint256 kb, bytes32 h) private pure returns (bytes memory) {
        if (vm.addr(ka) > vm.addr(kb)) (ka, kb) = (kb, ka);
        return bytes.concat(_sigBytes(ka, h), _sigBytes(kb, h));
    }

    /// A signature over the raw safeTxHash, as `cast wallet sign --no-hash`
    /// or an EIP-712 signer makes it.
    function _sig(uint256 key, bytes32 h) private pure returns (string memory) {
        return vm.toString(_sigBytes(key, h));
    }

    /// A personal_sign signature of the safeTxHash, as `cast wallet sign`
    /// without --no-hash makes it.
    function _ethSign(uint256 key, bytes32 h) private pure returns (string memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h)));
        return vm.toString(abi.encodePacked(r, s, v));
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
}
