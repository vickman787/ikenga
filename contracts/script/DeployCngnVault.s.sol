// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/IkengaVault.sol";

/// @notice Deploy the cNGN vault: a second IkengaVault instance whose
/// token is cNGN (0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f, 6 decimals).
///
/// WHY A SECOND VAULT, NOT ONE VAULT WITH TWO TOKENS
/// IkengaVault is already token-agnostic — its token is passed in the
/// constructor, never hardcoded. The USDT vault deployed 2026-11-23 holds
/// a real $1 and has registered escrows; changing its code would mean a
/// redeploy, migrating that $1, and re-registering escrows, for no gain.
/// A second instance holds the cNGN books separately and honestly: each
/// vault's four pots are in one currency only, /api/vault reads both, and
/// nothing is silently converted on accept — a cNGN job's cNGN lands in
/// the cNGN vault's OPERATING pot and stays cNGN. The boss of both
/// vaults is the same agent wallet, and the boss worker resolves which
/// vault an escrow belongs to from the escrow itself (its ikengaVault).
///
/// Run only after the user approves the mainnet broadcast (gas only, no
/// USDT moves). Record the address in contracts/deployments/celo.json
/// under cngnVault, and set IKENGA_CNGN_VAULT_ADDRESS in Vercel
/// Production — until then the site keeps cNGN hiring switched off.
///
/// Env vars (never put a private key in a file):
///   PRIVATE_KEY  deployer key, passed via --private-key $PRIVATE_KEY
///   IKENGA_BOSS  Boss wallet (default: deployer)
contract DeployCngnVault is Script {
    address constant CNGN = 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f;

    function run() external {
        address boss = vm.envOr("IKENGA_BOSS", msg.sender);

        vm.startBroadcast();

        IkengaVault vault = new IkengaVault(boss, CNGN);
        console.log("IkengaVault (cNGN) deployed:", address(vault));
        console.log("  boss:", boss);
        console.log("  token (cNGN):", CNGN);

        vm.stopBroadcast();
    }
}
