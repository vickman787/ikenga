// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/IkengaVault.sol";
import "../src/JobEscrow.sol";

/// @notice Deploy Ikenga contracts: Vault first, then one JobEscrow.
/// @dev Sepolia first, mainnet only after the Sepolia job passes and the
/// user approves the mainnet deploy. Deployer pays gas in CELO (CIP-64
/// stablecoin gas from Foundry is unverified - see plan section 2.4).
/// Env vars (never put a private key in a file):
///   PRIVATE_KEY       deployer key, passed via --private-key $PRIVATE_KEY
///   USDT_TOKEN        token address for escrow/vault (REQUIRED, no default:
///                     mainnet USDT 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
///                     Sepolia has no official USDT - pass a test token)
///   IKENGA_BOSS       Boss wallet (default: deployer)
///   IKENGA_CUSTOMER   escrow customer (default: deployer - Sepolia testing)
///   IKENGA_BOND       bond in atomic units (default: 200000 = 0.20 USDT)
///   IKENGA_SPEC_HASH  bytes32 hex spec hash (default: 0x0)
/// Record the printed addresses in deployments/celo.json (or
/// deployments/celo-sepolia.json for Sepolia).
contract Deploy is Script {
    function run() external {
        address token = vm.envAddress("USDT_TOKEN");
        address boss = vm.envOr("IKENGA_BOSS", msg.sender);
        address customer = vm.envOr("IKENGA_CUSTOMER", msg.sender);
        uint256 bond = vm.envOr("IKENGA_BOND", uint256(200_000));
        bytes32 specHash = vm.envOr("IKENGA_SPEC_HASH", bytes32(0));

        vm.startBroadcast();

        IkengaVault vault = new IkengaVault(boss, token);
        console.log("IkengaVault deployed:", address(vault));

        JobEscrow escrow = new JobEscrow(customer, address(vault), token, bond, specHash);
        console.log("JobEscrow deployed:", address(escrow));
        console.log("  customer:", customer);
        console.log("  bond (atomic USDT):", bond);

        vault.registerEscrow(address(escrow));
        console.log("Escrow registered in vault");

        vm.stopBroadcast();
    }
}
