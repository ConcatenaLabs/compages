// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CompagesVault} from "../src/CompagesVault.sol";

/// Deploys the vault with the deployer as both owner and operator.
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL \
///     --private-key $BRIDGE_OPERATOR_KEY --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        CompagesVault vault = new CompagesVault(msg.sender);
        vm.stopBroadcast();
        console.log("CompagesVault deployed at", address(vault));
        console.log("owner/operator", msg.sender);
    }
}
