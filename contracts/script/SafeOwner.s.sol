// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CompagesVault} from "../src/CompagesVault.sol";

/// @dev The parts of Safe v1.4.1 (safe-global/safe-smart-account) used here.
interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool);

    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);

    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function nonce() external view returns (uint256);
    function domainSeparator() external view returns (bytes32);
    function VERSION() external view returns (string memory);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external view returns (bytes memory);
}

/// Safe v1.4.1 as deployed canonically on Sepolia, and the arithmetic of a
/// Safe transaction. Addresses and runtime code hashes are those listed in
/// safe-global/safe-deployments (src/assets/v1.4.1, "canonical"); every step
/// re-checks the code hashes on the chain it runs against, so a chain where
/// these addresses hold something else is refused rather than trusted.
library SafeV141 {
    address internal constant SINGLETON_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;

    bytes32 internal constant SINGLETON_L2_CODEHASH =
        0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant PROXY_FACTORY_CODEHASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant FALLBACK_HANDLER_CODEHASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;

    /// keccak256("fallback_manager.handler.address"), where a Safe keeps its
    /// fallback handler. The singleton lives in slot 0 of the proxy.
    bytes32 internal constant FALLBACK_HANDLER_SLOT =
        0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    bytes32 internal constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)");
    bytes32 internal constant SAFE_TX_TYPEHASH = keccak256(
        "SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)"
    );

    /// A plain call with no gas refund: every field the Safe web app also
    /// leaves at zero, so the hash it shows matches the one printed here.
    struct SafeTx {
        address to;
        uint256 value;
        bytes data;
        uint8 operation;
        uint256 nonce;
    }

    function checkCanonical() internal view {
        require(SINGLETON_L2.codehash == SINGLETON_L2_CODEHASH, "SafeL2 1.4.1 singleton not at its canonical address");
        require(PROXY_FACTORY.codehash == PROXY_FACTORY_CODEHASH, "SafeProxyFactory 1.4.1 not at its canonical address");
        require(
            FALLBACK_HANDLER.codehash == FALLBACK_HANDLER_CODEHASH,
            "CompatibilityFallbackHandler 1.4.1 not at its canonical address"
        );
    }

    function initializer(address[] memory owners, uint256 threshold) internal pure returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup, (owners, threshold, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(address(0)))
        );
    }

    /// The address createProxyWithNonce will deploy to (CREATE2 by the factory).
    function predict(bytes memory init, uint256 saltNonce) internal view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(init), saltNonce));
        bytes memory code =
            abi.encodePacked(ISafeProxyFactory(PROXY_FACTORY).proxyCreationCode(), uint256(uint160(SINGLETON_L2)));
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), PROXY_FACTORY, salt, keccak256(code))))));
    }

    function domainSeparator(address safe) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, block.chainid, safe));
    }

    function hash(address safe, SafeTx memory t) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SAFE_TX_TYPEHASH,
                t.to,
                t.value,
                keccak256(t.data),
                t.operation,
                uint256(0),
                uint256(0),
                uint256(0),
                address(0),
                address(0),
                t.nonce
            )
        );
        return keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), domainSeparator(safe), structHash));
    }

    /// Turn signatures in any order into the byte string execTransaction
    /// takes: each an owner's, no owner twice, sorted by owner address. A
    /// signature over the raw hash (v 27/28) is used as is; one made with
    /// eth_sign / personal_sign over the same hash is marked as such (v + 4),
    /// which is how the Safe tells the two apart.
    function packSignatures(ISafe safe, bytes32 safeTxHash, bytes[] memory sigs)
        internal
        view
        returns (bytes memory packed, address[] memory signers)
    {
        uint256 n = sigs.length;
        signers = new address[](n);
        bytes[] memory fixedSigs = new bytes[](n);
        bytes32 ethSignHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", safeTxHash));
        for (uint256 i; i < n; i++) {
            require(sigs[i].length == 65, "each signature must be 65 bytes (r, s, v)");
            (bytes32 r, bytes32 s, uint8 v) = _split(sigs[i]);
            require(v >= 27, "signature v must be 27/28 (or 31/32 for eth_sign)");
            address signer;
            if (v > 30) {
                signer = ecrecover(ethSignHash, v - 4, r, s);
            } else {
                signer = ecrecover(safeTxHash, v, r, s);
                if (signer == address(0) || !safe.isOwner(signer)) {
                    address viaEthSign = ecrecover(ethSignHash, v, r, s);
                    if (viaEthSign != address(0) && safe.isOwner(viaEthSign)) {
                        signer = viaEthSign;
                        v += 4;
                    }
                }
            }
            require(
                signer != address(0) && safe.isOwner(signer), "a signature is not an owner's over this Safe tx hash"
            );
            signers[i] = signer;
            fixedSigs[i] = abi.encodePacked(r, s, v);
        }
        // Insertion sort by signer; a repeated signer is refused.
        for (uint256 i = 1; i < n; i++) {
            address a = signers[i];
            bytes memory sig = fixedSigs[i];
            uint256 j = i;
            while (j > 0 && signers[j - 1] > a) {
                signers[j] = signers[j - 1];
                fixedSigs[j] = fixedSigs[j - 1];
                j--;
            }
            signers[j] = a;
            fixedSigs[j] = sig;
        }
        for (uint256 i; i < n; i++) {
            require(i == 0 || signers[i - 1] < signers[i], "the same owner signed twice");
            packed = bytes.concat(packed, fixedSigs[i]);
        }
    }

    function _split(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }
}

/// Moves the vault's owner role to a Safe v1.4.1 multisig, in separate steps
/// so each is run with its own key handling (`--account`, `--ledger`, a
/// hardware wallet in the Safe web app); no step reads a key from the
/// environment. contrib/safe-owner.md is the runbook.
///
///   forge script script/SafeOwner.s.sol --sig 'deploySafe()'    1. deploy the Safe (any funded key)
///   forge script script/SafeOwner.s.sol --sig 'proposeSafe()'   2. current owner: transferOwnership(safe)
///   forge script script/SafeOwner.s.sol --sig 'acceptTx()'      3. print the Safe tx the signers sign
///   forge script script/SafeOwner.s.sol --sig 'execAccept()'    4. submit it with the collected signatures
///   forge script script/SafeOwner.s.sol                         status: roles, pending owner, the Safe
///
/// Handing ownership back to a single key is the same pair with
/// `handBackTx()` / `execHandBack()` and NEW_OWNER, after which NEW_OWNER
/// calls acceptOwnership() itself.
///
/// Environment:
///   VAULT             the vault (default: the live Sepolia vault)
///   SAFE_OWNERS       deploySafe: comma-separated signer addresses
///   SAFE_THRESHOLD    deploySafe: signatures required
///   SAFE_SALT_NONCE   deploySafe: CREATE2 salt nonce (default 0)
///   SAFE              every later step: the deployed Safe
///   SAFE_SIGNATURES   exec*: comma-separated 65-byte signatures, any order
///   NEW_OWNER         handBackTx / execHandBack: the key to hand back to
contract SafeOwner is Script {
    address constant LIVE_VAULT = 0x7B702D6A2E2351F0c4E549642e65AbABC0324384;

    function run() external view {
        status();
    }

    /// Roles on the vault, and when SAFE is set, what that Safe is.
    function status() public view {
        CompagesVault vault = _vault();
        console.log("chain id          ", block.chainid);
        console.log("vault             ", address(vault));
        console.log("owner             ", vault.owner());
        console.log("pendingOwner      ", vault.pendingOwner());
        console.log("guardian          ", vault.guardian());
        console.log("operator          ", vault.operator());
        address safe = vm.envOr("SAFE", address(0));
        if (safe != address(0)) {
            _checkSafe(safe);
            _printSafe(safe);
            if (vault.owner() == safe) console.log("the Safe owns the vault");
            else if (vault.pendingOwner() == safe) console.log("the Safe is pending owner: run acceptTx()");
        }
    }

    // ------------------------------------------------------------------
    // 1. Deploy the Safe
    // ------------------------------------------------------------------

    /// Deploy a SafeL2 proxy through the canonical factory, with the canonical
    /// fallback handler. Idempotent: the address is fixed by owners,
    /// threshold and salt nonce, and an already deployed Safe is reported,
    /// not deployed again.
    function deploySafe() external returns (address safe) {
        SafeV141.checkCanonical();
        address[] memory owners = vm.envAddress("SAFE_OWNERS", ",");
        uint256 threshold = vm.envUint("SAFE_THRESHOLD");
        uint256 saltNonce = vm.envOr("SAFE_SALT_NONCE", uint256(0));
        CompagesVault vault = _vault();

        require(threshold >= 1 && threshold <= owners.length, "SAFE_THRESHOLD must be between 1 and the owner count");
        for (uint256 i; i < owners.length; i++) {
            require(owners[i] != address(0), "zero address in SAFE_OWNERS");
            // The roles never merge: a hot or incident key must not also
            // count toward the owner's threshold.
            require(owners[i] != vault.operator(), "the vault operator (a hot key) cannot be a Safe owner");
            require(owners[i] != vault.guardian(), "the vault guardian cannot be a Safe owner");
            for (uint256 j; j < i; j++) {
                require(owners[i] != owners[j], "duplicate address in SAFE_OWNERS");
            }
        }
        if (threshold == 1) console.log("WARNING: threshold 1 makes any single signer the vault owner");

        bytes memory init = SafeV141.initializer(owners, threshold);
        safe = SafeV141.predict(init, saltNonce);
        _title("Step 1: deploy the Safe");
        console.log("SafeProxyFactory  ", SafeV141.PROXY_FACTORY);
        console.log("singleton (SafeL2)", SafeV141.SINGLETON_L2);
        console.log("fallback handler  ", SafeV141.FALLBACK_HANDLER);
        console.log("salt nonce        ", saltNonce);
        console.log("Safe address      ", safe);

        if (safe.code.length != 0) {
            console.log("already deployed at that address; nothing sent");
        } else {
            vm.startBroadcast();
            address deployed =
                ISafeProxyFactory(SafeV141.PROXY_FACTORY).createProxyWithNonce(SafeV141.SINGLETON_L2, init, saltNonce);
            vm.stopBroadcast();
            require(deployed == safe, "factory deployed to an unexpected address");
        }
        _checkSafe(safe);
        _printSafe(safe);
        console.log("");
        console.log("next: SAFE=%s, then the current owner runs proposeSafe()", safe);
    }

    // ------------------------------------------------------------------
    // 2. The current owner names the Safe
    // ------------------------------------------------------------------

    /// transferOwnership(SAFE), broadcast as the vault's current owner.
    /// Forge refuses to send it unless that owner's key is the one supplied
    /// (`--account`, `--ledger`, ...). Nothing changes hands until the Safe
    /// accepts; calling it again with another address replaces the pending
    /// owner, and transferOwnership(0) cancels it.
    function proposeSafe() external {
        CompagesVault vault = _vault();
        address safe = vm.envAddress("SAFE");
        _checkSafe(safe);
        _title("Step 2: the current owner names the Safe as pending owner");
        _printSafe(safe);
        address owner = vault.owner();
        require(owner != safe, "the Safe already owns the vault");
        console.log("current owner     ", owner);

        vm.startBroadcast(owner);
        vault.transferOwnership(safe);
        vm.stopBroadcast();

        require(vault.pendingOwner() == safe, "pendingOwner is not the Safe");
        console.log("pendingOwner      ", vault.pendingOwner());
        console.log("");
        console.log("next: acceptTx() prints the Safe transaction the signers sign");
    }

    // ------------------------------------------------------------------
    // 3 and 4. The Safe accepts
    // ------------------------------------------------------------------

    /// Print the Safe transaction for vault.acceptOwnership(), for the
    /// signers. Sends nothing.
    function acceptTx() external view returns (bytes32) {
        CompagesVault vault = _vault();
        address safe = vm.envAddress("SAFE");
        require(vault.pendingOwner() == safe, "the Safe is not the vault's pending owner: run proposeSafe() first");
        _title("Step 3: Safe transaction to sign: vault.acceptOwnership()");
        return _printSafeTx(safe, abi.encodeCall(CompagesVault.acceptOwnership, ()));
    }

    /// Submit vault.acceptOwnership() through the Safe with SAFE_SIGNATURES.
    /// Any funded key can send it; the signatures are what authorise it.
    function execAccept() external {
        CompagesVault vault = _vault();
        address safe = vm.envAddress("SAFE");
        require(vault.pendingOwner() == safe, "the Safe is not the vault's pending owner");
        _title("Step 4: execute vault.acceptOwnership() through the Safe");
        _exec(safe, abi.encodeCall(CompagesVault.acceptOwnership, ()), vm.envBytes("SAFE_SIGNATURES", ","));
        require(vault.owner() == safe, "the vault is not owned by the Safe");
        console.log("vault owner       ", vault.owner());
    }

    // ------------------------------------------------------------------
    // Handing ownership back to a single key
    // ------------------------------------------------------------------

    function handBackTx() external view returns (bytes32) {
        CompagesVault vault = _vault();
        address safe = vm.envAddress("SAFE");
        address newOwner = vm.envAddress("NEW_OWNER");
        require(vault.owner() == safe, "the Safe does not own the vault");
        _title("Safe transaction to sign: vault.transferOwnership(NEW_OWNER)");
        console.log("NEW_OWNER         ", newOwner);
        return _printSafeTx(safe, abi.encodeCall(CompagesVault.transferOwnership, (newOwner)));
    }

    /// Afterwards NEW_OWNER completes it with its own acceptOwnership().
    function execHandBack() external {
        CompagesVault vault = _vault();
        address safe = vm.envAddress("SAFE");
        address newOwner = vm.envAddress("NEW_OWNER");
        require(vault.owner() == safe, "the Safe does not own the vault");
        _title("Execute vault.transferOwnership(NEW_OWNER) through the Safe");
        _exec(safe, abi.encodeCall(CompagesVault.transferOwnership, (newOwner)), vm.envBytes("SAFE_SIGNATURES", ","));
        require(vault.pendingOwner() == newOwner, "pendingOwner is not NEW_OWNER");
        console.log("pendingOwner      ", newOwner);
        console.log("next: NEW_OWNER calls acceptOwnership() on the vault");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _vault() private view returns (CompagesVault vault) {
        vault = CompagesVault(vm.envOr("VAULT", LIVE_VAULT));
        require(address(vault).code.length != 0, "no contract at VAULT on this chain");
    }

    /// SAFE must be a proxy of the canonical SafeL2 1.4.1 with the canonical
    /// fallback handler: a Safe set up any other way is not what the
    /// signers were told they are signing for.
    function _checkSafe(address safe) private view {
        SafeV141.checkCanonical();
        require(safe.code.length != 0, "no contract at SAFE");
        require(
            address(uint160(uint256(vm.load(safe, bytes32(0))))) == SafeV141.SINGLETON_L2,
            "SAFE is not a proxy of the canonical SafeL2 1.4.1"
        );
        require(
            address(uint160(uint256(vm.load(safe, SafeV141.FALLBACK_HANDLER_SLOT)))) == SafeV141.FALLBACK_HANDLER,
            "SAFE does not use the canonical fallback handler"
        );
        require(keccak256(bytes(ISafe(safe).VERSION())) == keccak256("1.4.1"), "SAFE is not version 1.4.1");
        require(ISafe(safe).getThreshold() >= 1, "SAFE is not set up");
    }

    function _printSafe(address safe) private view {
        address[] memory owners = ISafe(safe).getOwners();
        console.log("Safe              ", safe);
        console.log("  version         ", ISafe(safe).VERSION());
        console.log("  threshold        %s of %s", ISafe(safe).getThreshold(), owners.length);
        for (uint256 i; i < owners.length; i++) {
            console.log("  owner           ", owners[i]);
        }
        console.log("  nonce           ", ISafe(safe).nonce());
    }

    function _safeTx(address safe, bytes memory data) private view returns (SafeV141.SafeTx memory) {
        return SafeV141.SafeTx({
            to: vm.envOr("VAULT", LIVE_VAULT), value: 0, data: data, operation: 0, nonce: ISafe(safe).nonce()
        });
    }

    /// The hash is computed here and must equal the Safe's own
    /// getTransactionHash, so what is printed is what the Safe will check.
    function _printSafeTx(address safe, bytes memory data) private view returns (bytes32 h) {
        SafeV141.SafeTx memory t = _safeTx(safe, data);
        h = SafeV141.hash(safe, t);
        require(ISafe(safe).domainSeparator() == SafeV141.domainSeparator(safe), "domain separator mismatch");
        require(
            h == ISafe(safe).getTransactionHash(t.to, 0, data, 0, 0, 0, 0, address(0), address(0), t.nonce),
            "safeTxHash disagrees with the Safe's getTransactionHash"
        );
        uint256 threshold = ISafe(safe).getThreshold();

        console.log("chainId           ", block.chainid);
        console.log("safe              ", safe);
        console.log("to                ", t.to);
        console.log("value              0");
        console.log("data              ", vm.toString(data));
        console.log("operation          0 (call)");
        console.log("safeTxGas          0");
        console.log("baseGas            0");
        console.log("gasPrice           0");
        console.log("gasToken           0x0000000000000000000000000000000000000000");
        console.log("refundReceiver     0x0000000000000000000000000000000000000000");
        console.log("nonce             ", t.nonce);
        console.log("domainSeparator   ", vm.toString(SafeV141.domainSeparator(safe)));
        console.log("safeTxHash        ", vm.toString(h));
        console.log("signatures needed ", threshold);
        console.log("");
        console.log("EIP-712 typed data (save as safe-tx.json for `cast wallet sign --data --from-file`):");
        console.log(_typedData(safe, t));
    }

    function _typedData(address safe, SafeV141.SafeTx memory t) private view returns (string memory) {
        return string.concat(
            '{"types":{"EIP712Domain":[{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}],',
            '"SafeTx":[{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"},',
            '{"name":"operation","type":"uint8"},{"name":"safeTxGas","type":"uint256"},{"name":"baseGas","type":"uint256"},',
            '{"name":"gasPrice","type":"uint256"},{"name":"gasToken","type":"address"},{"name":"refundReceiver","type":"address"},',
            '{"name":"nonce","type":"uint256"}]},"primaryType":"SafeTx",',
            '"domain":{"chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(safe),
            '"},"message":{"to":"',
            vm.toString(t.to),
            '","value":"0","data":"',
            vm.toString(t.data),
            '","operation":0,"safeTxGas":"0","baseGas":"0","gasPrice":"0",',
            '"gasToken":"0x0000000000000000000000000000000000000000",',
            '"refundReceiver":"0x0000000000000000000000000000000000000000","nonce":"',
            vm.toString(t.nonce),
            '"}}'
        );
    }

    function _exec(address safe, bytes memory data, bytes[] memory sigs) private {
        _checkSafe(safe);
        SafeV141.SafeTx memory t = _safeTx(safe, data);
        bytes32 h = SafeV141.hash(safe, t);
        (bytes memory packed, address[] memory signers) = SafeV141.packSignatures(ISafe(safe), h, sigs);
        require(signers.length >= ISafe(safe).getThreshold(), "fewer signatures than the Safe's threshold");
        console.log("safeTxHash        ", vm.toString(h));
        console.log("nonce             ", t.nonce);
        for (uint256 i; i < signers.length; i++) {
            console.log("  signed by       ", signers[i]);
        }

        vm.startBroadcast();
        bool ok = ISafe(safe).execTransaction(t.to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), packed);
        vm.stopBroadcast();
        require(ok, "execTransaction failed");
        require(ISafe(safe).nonce() == t.nonce + 1, "the Safe nonce did not advance");
    }

    function _title(string memory s) private pure {
        console.log("");
        console.log(string.concat("== ", s));
    }
}
