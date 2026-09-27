// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CompagesVault} from "../src/CompagesVault.sol";

/// Deploys the vault with explicit roles, read from the environment:
///   OWNER          Safe or cold key: limits, roles, unpausing, rebalancing
///   OPERATOR       the daemon's hot key: releases and refunds within limits
///   GUARDIAN       incident key: can pause and cancel queued releases only
///   RELEASE_DELAY  seconds a release over the rate limit waits (max 30 days)
/// Usage:
///   OWNER=0x.. OPERATOR=0x.. GUARDIAN=0x.. RELEASE_DELAY=86400 \
///   forge script script/Deploy.s.sol --rpc-url $ETH_RPC_URL \
///     --private-key $DEPLOYER_KEY --broadcast
/// The deployer holds no role. Release limits and CCTP are configured by the
/// owner afterwards; until then every release is queued.
contract Deploy is Script {
    function run() external returns (CompagesVault vault) {
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");
        address guardian = vm.envAddress("GUARDIAN");
        uint256 releaseDelay = vm.envUint("RELEASE_DELAY");

        vm.startBroadcast();
        vault = new CompagesVault(owner, operator, guardian, releaseDelay);
        vm.stopBroadcast();

        console.log("CompagesVault deployed at", address(vault));
        console.log("owner   ", owner);
        console.log("operator", operator);
        console.log("guardian", guardian);
        console.log("release delay (s)", releaseDelay);
    }
}
