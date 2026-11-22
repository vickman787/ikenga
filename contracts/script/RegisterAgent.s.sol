// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// @title RegisterAgent - ERC-8004 agent registration helper.
/// @notice Registers the Ikenga agent on the ERC-8004 IdentityRegistry.
/// Mint-first-then-patch flow (plan section 2.4 / EIP-8004):
///   1. Run this script with an agentURI that resolves (it may point at a
///      registration file whose `registrations` array is still empty).
///   2. `register()` mints a new ERC-721 and returns the agentId.
///      Record it - `register()` always mints a NEW id, never re-register.
///   3. Patch the returned agentId into the registration file at the same
///      URL, OR call this script again with IKENGA_AGENT_ID set and a new
///      IKENGA_AGENT_URI to run setAgentURI(agentId, newURI) (owner only).
/// Env vars (never put a private key in a file):
///   PRIVATE_KEY           agent-owner key, via --private-key $PRIVATE_KEY
///   IKENGA_AGENT_URI      REQUIRED: https:// / ipfs:// / data: URI of the
///                         agent registration file
///   IKENGA_NETWORK        sepolia (default) or mainnet
///   IKENGA_AGENT_ID       if set (>0): update that agent's URI instead of
///                         minting a new registration
///   IKENGA_ALLOW_MAINNET  must be "true" to run against mainnet (42220)
/// DO NOT execute on mainnet without the user's explicit approval.
/// Sepolia execution also needs a funded test key in env - none exists in
/// this environment, so this script is ready but UNEXECUTED.
interface IIdentityRegistry {
    struct MetadataEntry {
        string key;
        bytes value;
    }

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId);

    function setAgentURI(uint256 agentId, string calldata newURI) external;
}

contract RegisterAgent is Script {
    address constant MAINNET_REGISTRY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address constant SEPOLIA_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        string memory network = vm.envOr("IKENGA_NETWORK", string("sepolia"));
        string memory agentURI = vm.envString("IKENGA_AGENT_URI");
        uint256 agentId = vm.envOr("IKENGA_AGENT_ID", uint256(0));

        address registry;
        if (keccak256(bytes(network)) == keccak256(bytes("mainnet"))) {
            require(
                keccak256(bytes(vm.envOr("IKENGA_ALLOW_MAINNET", string("false"))))
                    == keccak256(bytes("true")),
                "RegisterAgent: mainnet needs IKENGA_ALLOW_MAINNET=true"
            );
            registry = MAINNET_REGISTRY;
        } else if (keccak256(bytes(network)) == keccak256(bytes("sepolia"))) {
            registry = SEPOLIA_REGISTRY;
        } else {
            revert("RegisterAgent: IKENGA_NETWORK must be sepolia or mainnet");
        }
        require(bytes(agentURI).length > 0, "RegisterAgent: IKENGA_AGENT_URI is empty");

        console.log("Network:", network);
        console.log("IdentityRegistry:", registry);
        console.log("agentURI:", agentURI);

        vm.startBroadcast();

        if (agentId > 0) {
            IIdentityRegistry(registry).setAgentURI(agentId, agentURI);
            console.log("setAgentURI done for agentId:", agentId);
        } else {
            IIdentityRegistry.MetadataEntry[] memory metadata = new IIdentityRegistry.MetadataEntry[](0);
            uint256 newId = IIdentityRegistry(registry).register(agentURI, metadata);
            console.log("Registered agentId:", newId);
            console.log("RECORD THIS agentId - patch it into the registration file,");
            console.log("then re-run with IKENGA_AGENT_ID=<id> if the URI changes.");
        }

        vm.stopBroadcast();
    }
}
