// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CompagesVault} from "../../src/CompagesVault.sol";

/// @notice Rejects plain ether, like a contract without receive() or an
///         EIP-7702 account whose delegate does not accept it. It can still
///         act, so it can claim what the vault owes it.
contract RejectingReceiver {
    receive() external payable {
        revert("no plain ether");
    }

    function claimFrom(CompagesVault vault, address token, address payable payTo) external {
        vault.claim(token, payTo);
    }
}

/// @notice Burns every unit of gas it is given when receiving ether.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// @notice Tries to re-enter the vault while being paid, and records whether
///         the vault let it.
contract ReentrantReceiver {
    CompagesVault public vault;
    bool public reentered;

    constructor(CompagesVault v) {
        vault = v;
    }

    receive() external payable {
        try vault.claim(address(0), payable(address(this))) {
            reentered = true;
        } catch {}
    }
}
