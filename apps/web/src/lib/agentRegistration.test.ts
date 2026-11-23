import { describe, expect, it } from "vitest";
import {
  agentRegistration,
  IKENGA_AGENT_ID,
  IKENGA_AGENT_REGISTRY,
  IKENGA_AGENT_WALLET,
} from "./agentRegistration.js";

describe("agentRegistration", () => {
  it("follows the EIP-8004 registration-v1 shape", () => {
    const file = agentRegistration();
    expect(file.type).toBe(
      "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    );
    expect(file.name).toBe("Ikenga");
    expect(file.description.length).toBeGreaterThan(50);
    expect(file.image).toBe("https://ikenga-two.vercel.app/logo.png");
    expect(file.owner).toBe(IKENGA_AGENT_WALLET);
    expect(file.services.length).toBeGreaterThan(0);
    for (const service of file.services) {
      expect(service.name.length).toBeGreaterThan(0);
      expect(service.endpoint.startsWith("https://ikenga-two.vercel.app/")).toBe(
        true,
      );
    }
    expect(file.x402Support).toBe(true);
    expect(file.active).toBe(true);
    expect(Array.isArray(file.registrations)).toBe(true);
  });

  it("lists no registration before minting, and the registry string is Celo mainnet", () => {
    expect(IKENGA_AGENT_REGISTRY).toBe(
      "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    );
    // Before the mint, the file honestly carries no agentId.
    if (IKENGA_AGENT_ID === null) {
      expect(agentRegistration().registrations).toEqual([]);
    } else {
      expect(agentRegistration().registrations).toEqual([
        { agentId: IKENGA_AGENT_ID, agentRegistry: IKENGA_AGENT_REGISTRY },
      ]);
    }
  });
});
