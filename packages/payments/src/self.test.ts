/**
 * Self Agent ID gate tests (Workstream C, Step 2).
 *
 * Pure/config tests, mocked-verifier result mapping, cache behaviour, and
 * the nullifier-never-leaves rule. Live tests are gated on
 * IKENGA_LIVE_TESTS=1 and read the real Sepolia registry (read-only, no
 * registration, no key).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentKeyForAddress,
  buildSelfVerifier,
  clearSelfVerificationCache,
  readRegistryDirect,
  resolveSelfConfig,
  SELF_CACHE_TTL_MS,
  SELF_REGISTRY_MAINNET,
  SELF_REGISTRY_SEPOLIA,
  SELF_REPLAY_WINDOW_MS,
  verifySelfAgentId,
  verifySignedAgentRequest,
  type RegistryStatus,
  type SelfDeps,
  type VerifyResult,
} from "./self.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const RANDOM_UNREGISTERED = "0x000000000000000000000000000000000000dEaD";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  clearSelfVerificationCache();
  process.env.SELF_NETWORK = "mainnet";
  delete process.env.SELF_SYBIL_LIMIT;
  delete process.env.SELF_RPC_URL;
  delete process.env.SELF_RATE_LIMIT_PER_MINUTE;
  delete process.env.SELF_RATE_LIMIT_PER_HOUR;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function verifiedSdk(agentId = 7n, expiresAt: Date | null = new Date("2027-06-01T00:00:00.000Z")): VerifyResult {
  return { verified: true, agentId, expiresAt };
}

/** Deps for a verified agent that never touch the chain (sybil count stubbed). */
function verifiedDeps(sdkResult: VerifyResult = verifiedSdk()): SelfDeps {
  return { sdkVerifyAgent: async () => sdkResult, registryReader: async () => status() };
}

function status(over: Partial<RegistryStatus> = {}): RegistryStatus {
  return {
    agentId: 7n,
    hasHumanProof: true,
    proofFresh: true,
    expiresAt: new Date("2027-06-01T00:00:00.000Z"),
    agentCount: 1n,
    ...over,
  };
}

describe("resolveSelfConfig (pure)", () => {
  it("defaults to Celo mainnet with the verified registry address", () => {
    const cfg = resolveSelfConfig({});
    expect(cfg.network).toBe("mainnet");
    expect(cfg.sdkNetwork).toBe("mainnet");
    expect(cfg.registryAddress).toBe(SELF_REGISTRY_MAINNET);
    expect(cfg.registryAddress).toBe("0xaC3DF9ABf80d0F5c020C06B04Cced27763355944");
  });

  it("maps SELF_NETWORK=sepolia to the SDK testnet + Sepolia registry", () => {
    const cfg = resolveSelfConfig({ SELF_NETWORK: "sepolia" });
    expect(cfg.network).toBe("sepolia");
    expect(cfg.sdkNetwork).toBe("testnet");
    expect(cfg.registryAddress).toBe(SELF_REGISTRY_SEPOLIA);
    expect(cfg.registryAddress).toBe("0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379");
  });

  it("rejects an unknown SELF_NETWORK instead of silently defaulting", () => {
    expect(() => resolveSelfConfig({ SELF_NETWORK: "alfajores" })).toThrow(/SELF_NETWORK/);
  });

  it("makes the sybil limit explicit: unset defaults to 1 (the SDK default trap)", () => {
    expect(resolveSelfConfig({}).sybilLimit).toBe(1);
    expect(resolveSelfConfig({ SELF_SYBIL_LIMIT: "0" }).sybilLimit).toBe(0);
    expect(resolveSelfConfig({ SELF_SYBIL_LIMIT: "3" }).sybilLimit).toBe(3);
    expect(() => resolveSelfConfig({ SELF_SYBIL_LIMIT: "-1" })).toThrow(/SELF_SYBIL_LIMIT/);
    expect(() => resolveSelfConfig({ SELF_SYBIL_LIMIT: "many" })).toThrow(/SELF_SYBIL_LIMIT/);
  });

  it("sets the replay window to 300 s and the cache TTL to 1 hour", () => {
    const cfg = resolveSelfConfig({});
    expect(cfg.replayWindowMs).toBe(300_000);
    expect(SELF_REPLAY_WINDOW_MS).toBe(300_000);
    expect(cfg.cacheTtlMs).toBe(3_600_000);
    expect(SELF_CACHE_TTL_MS).toBe(3_600_000);
  });
});

describe("agentKeyForAddress", () => {
  it("zero-pads the address to 32 bytes", () => {
    expect(agentKeyForAddress(ADDR)).toBe(
      "0x0000000000000000000000001111111111111111111111111111111111111111",
    );
  });
});

describe("buildSelfVerifier", () => {
  it("builds a verifier for the configured network (replay + rate limit on)", () => {
    const v = buildSelfVerifier(resolveSelfConfig({ SELF_NETWORK: "sepolia", SELF_SYBIL_LIMIT: "0" }));
    expect(v).toBeDefined();
    expect(typeof v.verify).toBe("function");
    expect(typeof v.auth).toBe("function");
  });
});

describe("verifySelfAgentId — result mapping (mocked SDK)", () => {
  it("maps a verified SDK result to verified:true with agentId + expiry", async () => {
    const r = await verifySelfAgentId(ADDR, undefined, { deps: verifiedDeps() });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe("VERIFIED");
    expect(r.agentId).toBe("7");
    expect(r.agentAddress).toBe(ADDR);
    expect(r.expiresAt).toBe("2027-06-01T00:00:00.000Z");
    expect(r.checkedAt).toBeTruthy();
  });

  it.each([
    ["NOT_REGISTERED", { verified: false, reason: "NOT_REGISTERED" } as VerifyResult],
    ["NO_HUMAN_PROOF", { verified: false, reason: "NO_HUMAN_PROOF" } as VerifyResult],
    [
      "PROOF_EXPIRED",
      {
        verified: false,
        reason: "PROOF_EXPIRED",
        expiredAt: new Date("2026-01-01T00:00:00.000Z"),
        reauthUrl: "https://agent-api.self.xyz/api/agent/refresh?agentId=7",
      } as VerifyResult,
    ],
  ])("maps %s to verified:false with that distinct reason", async (_label, sdkResult) => {
    const deps: SelfDeps = { sdkVerifyAgent: async () => sdkResult };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe((sdkResult as { reason: string }).reason);
  });

  it("carries the expiry date on PROOF_EXPIRED", async () => {
    const deps: SelfDeps = {
      sdkVerifyAgent: async () => ({
        verified: false,
        reason: "PROOF_EXPIRED",
        expiredAt: new Date("2026-01-01T00:00:00.000Z"),
        reauthUrl: "https://example.invalid/refresh",
      }),
    };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.reason).toBe("PROOF_EXPIRED");
    expect(r.expiresAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("refuses when the on-chain agent id does not match the expected id", async () => {
    const r = await verifySelfAgentId(ADDR, "8", { deps: verifiedDeps(verifiedSdk(7n)) });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("AGENT_ID_MISMATCH");
  });

  it("refuses an invalid address without touching the chain", async () => {
    const sdkVerifyAgent = vi.fn(async () => verifiedSdk());
    const r = await verifySelfAgentId("not-an-address", undefined, { deps: { sdkVerifyAgent } });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("INVALID_ADDRESS");
    expect(sdkVerifyAgent).not.toHaveBeenCalled();
  });

  it("maps a sybil-over-limit human to SYBIL_LIMIT_EXCEEDED", async () => {
    const deps: SelfDeps = {
      sdkVerifyAgent: async () => verifiedSdk(),
      registryReader: async () => status({ agentCount: 2n }),
    };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("SYBIL_LIMIT_EXCEEDED");
  });

  it("passes when the human is within the explicit sybil limit", async () => {
    const deps: SelfDeps = {
      sdkVerifyAgent: async () => verifiedSdk(),
      registryReader: async () => status({ agentCount: 1n }),
    };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.verified).toBe(true);
  });

  it("skips the sybil count entirely when SELF_SYBIL_LIMIT=0", async () => {
    process.env.SELF_SYBIL_LIMIT = "0";
    const registryReader = vi.fn(async () => status({ agentCount: 99n }));
    const deps: SelfDeps = { sdkVerifyAgent: async () => verifiedSdk(), registryReader };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.verified).toBe(true);
    expect(registryReader).not.toHaveBeenCalled();
  });
});

describe("verifySelfAgentId — direct-registry fallback (mocked reader)", () => {
  const throwingSdk: SelfDeps["sdkVerifyAgent"] = async () => {
    throw new Error("rpc down");
  };

  it("falls back to the registry read when the SDK lookup throws", async () => {
    const deps: SelfDeps = { sdkVerifyAgent: throwingSdk, registryReader: async () => status() };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.verified).toBe(true);
    expect(r.agentId).toBe("7");
  });

  it("fallback maps agentId 0 / no proof / stale proof distinctly", async () => {
    const cases: Array<[RegistryStatus, string]> = [
      [status({ agentId: 0n, hasHumanProof: false, proofFresh: false, expiresAt: null }), "NOT_REGISTERED"],
      [status({ hasHumanProof: false }), "NO_HUMAN_PROOF"],
      [status({ proofFresh: false, expiresAt: new Date("2026-01-01T00:00:00.000Z") }), "PROOF_EXPIRED"],
    ];
    for (const [s, reason] of cases) {
      clearSelfVerificationCache();
      const deps: SelfDeps = { sdkVerifyAgent: throwingSdk, registryReader: async () => s };
      const r = await verifySelfAgentId(ADDR, undefined, { deps });
      expect(r.verified).toBe(false);
      expect(r.reason).toBe(reason);
    }
  });

  it("fails closed with CHAIN_UNREADABLE when both paths throw", async () => {
    const deps: SelfDeps = {
      sdkVerifyAgent: throwingSdk,
      registryReader: async () => {
        throw new Error("rpc down");
      },
    };
    const r = await verifySelfAgentId(ADDR, undefined, { deps });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("CHAIN_UNREADABLE");
  });
});

describe("verifySelfAgentId — cache", () => {
  it("second call within the hour does not re-read the chain", async () => {
    const sdkVerifyAgent = vi.fn(async () => verifiedSdk());
    const deps: SelfDeps = { sdkVerifyAgent, registryReader: async () => status() };
    await verifySelfAgentId(ADDR, undefined, { deps });
    await verifySelfAgentId(ADDR, undefined, { deps });
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(1);
  });

  it("cache is keyed by address + agentId + network", async () => {
    const sdkVerifyAgent = vi.fn(async () => verifiedSdk());
    const deps: SelfDeps = { sdkVerifyAgent, registryReader: async () => status() };
    await verifySelfAgentId(ADDR, undefined, { deps });
    await verifySelfAgentId(ADDR, "7", { deps }); // different agentId key
    await verifySelfAgentId(OTHER, undefined, { deps }); // different address key
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(3);
    process.env.SELF_NETWORK = "sepolia";
    await verifySelfAgentId(ADDR, undefined, { deps }); // different network key
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(4);
  });

  it("expired cache re-verifies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-21T09:00:00.000Z"));
    const sdkVerifyAgent = vi.fn(async () => verifiedSdk());
    const deps: SelfDeps = { sdkVerifyAgent, registryReader: async () => status() };
    await verifySelfAgentId(ADDR, undefined, { deps });
    await verifySelfAgentId(ADDR, undefined, { deps });
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-21T10:00:01.000Z")); // 1h + 1s later
    await verifySelfAgentId(ADDR, undefined, { deps });
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh bypasses the cache (the pre-payment re-verify)", async () => {
    const sdkVerifyAgent = vi.fn(async () => verifiedSdk());
    const deps: SelfDeps = { sdkVerifyAgent, registryReader: async () => status() };
    await verifySelfAgentId(ADDR, undefined, { deps });
    await verifySelfAgentId(ADDR, undefined, { deps, forceRefresh: true });
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(2);
  });

  it("CHAIN_UNREADABLE is never cached", async () => {
    const sdkVerifyAgent = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const registryReader = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const deps: SelfDeps = { sdkVerifyAgent, registryReader };
    await verifySelfAgentId(ADDR, undefined, { deps });
    await verifySelfAgentId(ADDR, undefined, { deps });
    expect(sdkVerifyAgent).toHaveBeenCalledTimes(2);
    expect(registryReader).toHaveBeenCalledTimes(2);
  });
});

describe("nullifier never leaves the module", () => {
  it("no returned object contains a nullifier field, in any outcome", async () => {
    const outcomes: Array<Promise<unknown>> = [];
    const depsVerified: SelfDeps = verifiedDeps();
    outcomes.push(verifySelfAgentId(ADDR, undefined, { deps: depsVerified }));
    const depsFailed: SelfDeps = { sdkVerifyAgent: async () => ({ verified: false, reason: "NOT_REGISTERED" }) };
    outcomes.push(verifySelfAgentId(OTHER, undefined, { deps: depsFailed }));
    outcomes.push(
      verifySignedAgentRequest(
        { signature: "0x00", timestamp: String(Date.now()), method: "GET", url: "/x" },
        {
          deps: {
            verifierFactory: () => ({
              verify: async () => ({
                valid: true,
                agentAddress: ADDR,
                agentKey: "0x00",
                agentId: 7n,
                agentCount: 1n,
                nullifier: 12345n,
              }),
            }),
          },
        },
      ),
    );
    for (const p of outcomes) {
      const r = (await p) as Record<string, unknown>;
      expect(r).not.toHaveProperty("nullifier");
      expect(JSON.stringify(r)).not.toContain("nullifier");
    }
  });
});

describe("verifySignedAgentRequest — reason mapping (mocked verifier)", () => {
  const base = { signature: "0x00", timestamp: String(Date.now()), method: "GET", url: "/x" };

  it.each([
    ["Timestamp expired or invalid", "STALE_TIMESTAMP"],
    ["Replay detected", "REPLAY_DETECTED"],
    ["Human has 2 agents (max 1)", "SYBIL_LIMIT_EXCEEDED"],
    ["provider mismatch", "PROVIDER_MISMATCH"],
    ["does not meet minimum age (got: 0)", "AGE_OR_OFAC_FAIL"],
    ["Agent not verified on-chain", "NOT_REGISTERED"],
    ["proof expired", "PROOF_EXPIRED"],
  ])("maps verifier error %p to %s", async (error, reason) => {
    const r = await verifySignedAgentRequest(base, {
      deps: {
        verifierFactory: () => ({
          verify: async () => ({
            valid: false,
            agentAddress: ADDR,
            agentKey: "0x00",
            agentId: 0n,
            agentCount: 0n,
            nullifier: 0n,
            error,
          }),
        }),
      },
    });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it("maps a rate-limited verifier result to RATE_LIMITED", async () => {
    const r = await verifySignedAgentRequest(base, {
      deps: {
        verifierFactory: () => ({
          verify: async () => ({
            valid: false,
            agentAddress: ADDR,
            agentKey: "0x00",
            agentId: 7n,
            agentCount: 1n,
            nullifier: 0n,
            error: "rate limited",
            retryAfterMs: 60_000,
          }),
        }),
      },
    });
    expect(r.reason).toBe("RATE_LIMITED");
  });

  it("passes a valid signed request through with agentId + expiry", async () => {
    const r = await verifySignedAgentRequest(base, {
      deps: {
        verifierFactory: () => ({
          verify: async () => ({
            valid: true,
            agentAddress: ADDR,
            agentKey: "0x00",
            agentId: 7n,
            agentCount: 1n,
            nullifier: 999n,
            proofExpiresAt: new Date("2027-06-01T00:00:00.000Z"),
          }),
        }),
      },
    });
    expect(r.verified).toBe(true);
    expect(r.agentId).toBe("7");
    expect(r.expiresAt).toBe("2027-06-01T00:00:00.000Z");
  });
});

const LIVE = process.env.IKENGA_LIVE_TESTS === "1";

describe.skipIf(!LIVE)("live Sepolia registry read (read-only, no registration)", () => {
  it("a random address is NOT_REGISTERED on the Sepolia registry", async () => {
    process.env.SELF_NETWORK = "sepolia";
    clearSelfVerificationCache();
    const r = await verifySelfAgentId(RANDOM_UNREGISTERED, undefined, { forceRefresh: true });
    expect(r.verified).toBe(false);
    expect(r.reason).toBe("NOT_REGISTERED");
    expect(r.agentId).toBeNull();
  }, 30_000);

  it("direct viem eth_call to the Sepolia registry returns agentId 0", async () => {
    process.env.SELF_NETWORK = "sepolia";
    const cfg = resolveSelfConfig();
    const s = await readRegistryDirect(agentKeyForAddress(RANDOM_UNREGISTERED), cfg);
    expect(s.agentId).toBe(0n);
    expect(s.hasHumanProof).toBe(false);
    expect(s.proofFresh).toBe(false);
  }, 30_000);

  it("the registered testnet agent (SELF_AGENT_ID + SELF_AGENT_ADDRESS) verifies", async () => {
    // Skipped unless the user has registered a testnet agent (human QR step).
    if (!process.env.SELF_AGENT_ID || !process.env.SELF_AGENT_ADDRESS) {
      console.log("skip: SELF_AGENT_ID / SELF_AGENT_ADDRESS not set — no agent registered yet");
      return;
    }
    process.env.SELF_NETWORK = "sepolia";
    clearSelfVerificationCache();
    const r = await verifySelfAgentId(process.env.SELF_AGENT_ADDRESS, process.env.SELF_AGENT_ID, {
      forceRefresh: true,
    });
    expect(r.verified).toBe(true);
    expect(r.reason).toBe("VERIFIED");
    expect(r.agentId).toBe(process.env.SELF_AGENT_ID);
  }, 30_000);
});
