/**
 * @ikenga/payments — Self Agent ID gate (Track 3).
 *
 * The CFO serves or pays an agent ONLY when `verifySelfAgentId` returns
 * `verified: true`. The gate defaults closed: any error reading the chain
 * is a refusal, never a pass.
 *
 * Verified against the INSTALLED SDK `@selfxyz/agent-sdk@0.3.1`
 * (plan §2.3 said v0.3.1 — confirmed at install time, `latest` on npm):
 *
 * - Registry addresses in the SDK's own `NETWORKS` constant match the plan:
 *   mainnet `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944`,
 *   testnet (Celo Sepolia) `0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379`.
 * - The CFO gate is a *signature-free on-chain lookup*, not a signed-request
 *   check: the SDK's `verifyAgent(agentKey, { network })` returns
 *   `{ verified: true, agentId, expiresAt }` or
 *   `{ verified: false, reason: "NOT_REGISTERED" | "NO_HUMAN_PROOF" |
 *   "PROOF_EXPIRED", ... }`. It reads `isVerifiedAgent` + `isProofFresh`
 *   on-chain (verified = hasHumanProof && isProofFresh).
 * - `SelfAgentVerifier.verify()` is the *signed-request* path (an agent signs
 *   `keccak256(timestamp + METHOD + path + keccak256(body))` and the service
 *   recovers the signer). It is used here only by
 *   `verifySignedAgentRequest()` for inbound agent requests; the CFO gate
 *   itself has no signed request to verify.
 * - Replay window: SDK default `maxAgeMs` is 300_000 ms (300 s) — set
 *   explicitly here, never relied on as an implicit default.
 * - Proof-refresh contradiction in the plan (PyPI 0.2.1 said "no in-place
 *   refresh", official docs said refresh exists): RESOLVED in favour of the
 *   official docs — the installed SDK 0.3.1 exports `requestProofRefresh`.
 *   Proofs expire at min(document expiry, registration + 365 days).
 *
 * SYBIL-LIMIT TRAP (read this before changing the default): the SDK
 * verifier's default sybil limit is **1 agent per human**. If the same
 * human backs a second agent, the default rejects it with
 * `Human has N agents (max 1)`. `SELF_SYBIL_LIMIT` must therefore be set
 * explicitly for Ikenga (one human, the user, may back several agents):
 * `0` disables the check, any positive integer is the cap. When the env var
 * is unset this module defaults to 1 — the SDK default — and says so loudly
 * in `resolveSelfConfig()`. That default is fail-closed, not a
 * recommendation. The recommended Ikenga value is a user decision
 * (see the integration phase); do NOT silently change it to 0.
 *
 * NULLIFIER: the human nullifier is NEVER returned, logged, or stored by
 * this module. It is read on-chain only as an intermediate input to
 * `getAgentCountForHuman` for the sybil check, and discarded immediately.
 * The return type has no nullifier field at all.
 *
 * CACHE POLICY: a verification result is cached for 1 hour, keyed by
 * address + agentId + network (proofs do not change minute to minute).
 * The integration layer MUST re-verify with `{ forceRefresh: true }`
 * before any payment above the payment threshold — a cached `verified: true`
 * is not sufficient for a large payment. Chain-read failures
 * (`CHAIN_UNREADABLE`) are never cached.
 *
 * No private keys are read here. `AGENT_PRIVATE_KEY` belongs to the agent
 * process that *signs* requests; verification needs no key at all.
 */

import {
  NETWORKS,
  REGISTRY_ABI,
  SelfAgentVerifier,
  verifyAgent,
  type NetworkName,
  type VerificationResult,
  type VerifyResult,
} from "@selfxyz/agent-sdk";

export type { VerifyResult } from "@selfxyz/agent-sdk";
import {
  createPublicClient,
  getAddress,
  http,
  pad,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/** Celo mainnet SelfAgentRegistry (plan §2.3, confirmed in SDK NETWORKS). */
export const SELF_REGISTRY_MAINNET = "0xaC3DF9ABf80d0F5c020C06B04Cced27763355944" as const;
/** Celo Sepolia SelfAgentRegistry (plan §2.3, confirmed in SDK NETWORKS). */
export const SELF_REGISTRY_SEPOLIA = "0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379" as const;

/** Replay window: signed timestamps older than this are rejected (300 s). */
export const SELF_REPLAY_WINDOW_MS = 300_000;
/** Verification-result cache TTL: 1 hour. */
export const SELF_CACHE_TTL_MS = 3_600_000;

/** Registry ABI subset used by the direct on-chain fallback (from the SDK). */
const FALLBACK_ABI = parseAbi(REGISTRY_ABI);

export type SelfNetwork = "mainnet" | "sepolia";

export interface SelfConfig {
  /** "mainnet" (Celo 42220) or "sepolia" (Celo Sepolia 11142220). */
  network: SelfNetwork;
  /** SDK network name: "mainnet" | "testnet" (Sepolia is "testnet" in the SDK). */
  sdkNetwork: NetworkName;
  registryAddress: Address;
  rpcUrl: string;
  /**
   * Max agents per human. 0 = no limit. Default 1 = the SDK default.
   * WARNING: 1 rejects a second agent backed by the same human — set this
   * explicitly via SELF_SYBIL_LIMIT for Ikenga (see module docs).
   */
  sybilLimit: number;
  /** Signed-request timestamp window (ms). Always 300_000. */
  replayWindowMs: number;
  /** In-memory per-agent rate limit for signed-request verification. */
  rateLimitPerMinute: number;
  rateLimitPerHour: number;
  /** Verification-result cache TTL (ms). Always 3_600_000. */
  cacheTtlMs: number;
}

export type SelfVerificationReason =
  | "VERIFIED"
  | "NOT_REGISTERED"
  | "NO_HUMAN_PROOF"
  | "PROOF_EXPIRED"
  | "SYBIL_LIMIT_EXCEEDED"
  | "STALE_TIMESTAMP"
  | "REPLAY_DETECTED"
  | "RATE_LIMITED"
  | "INVALID_ADDRESS"
  | "AGENT_ID_MISMATCH"
  | "PROVIDER_MISMATCH"
  | "AGE_OR_OFAC_FAIL"
  | "CHAIN_UNREADABLE"
  | "VERIFICATION_FAILED";

/**
 * What the CFO gate returns. Deliberately JSON-safe (no bigint) so it can
 * go straight into the hash-chained ledger. There is NO nullifier field —
 * by design, never add one.
 */
export interface SelfVerificationResult {
  /** On-chain agent id as a decimal string, or null when not registered. */
  agentId: string | null;
  /** Checksummed agent address that was verified. */
  agentAddress: Address;
  verified: boolean;
  reason: SelfVerificationReason;
  /** ISO timestamp when the human proof expires (or expired). */
  expiresAt?: string;
  /** ISO timestamp of this check. */
  checkedAt: string;
}

export interface VerifySelfAgentIdOptions {
  /**
   * Bypass the 1-hour cache and re-read the chain. The integration layer
   * MUST set this before any payment above the payment threshold.
   */
  forceRefresh?: boolean;
  /** Test/override seam: inject a fake SDK lookup or registry reader. */
  deps?: SelfDeps;
}

export interface SelfDeps {
  sdkVerifyAgent?: (agentKey: Hex, opts: { network: NetworkName }) => Promise<VerifyResult>;
  registryReader?: (agentKey: Hex, config: SelfConfig) => Promise<RegistryStatus>;
  verifierFactory?: (config: SelfConfig) => {
    verify: (params: {
      signature: string;
      timestamp: string;
      method: string;
      url: string;
      body?: string;
      keytype?: string;
      agentKey?: string;
    }) => Promise<VerificationResult>;
  };
}

/** Raw on-chain status from the direct registry read (fallback path). */
export interface RegistryStatus {
  agentId: bigint;
  hasHumanProof: boolean;
  proofFresh: boolean;
  expiresAt: Date | null;
  /** Agents backed by the same human (0n when the sybil check is disabled). */
  agentCount: bigint;
}

function parseEnvInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Pure config resolution. Reads env only; throws on an invalid value
 * instead of silently falling back (a gate must fail loudly at startup).
 *
 * - `SELF_NETWORK`: `mainnet` (default) or `sepolia`. Anything else throws.
 * - `SELF_SYBIL_LIMIT`: explicit cap; `0` disables. Unset → 1 (SDK default;
 *   fail-closed, see the sybil-limit trap in the module docs).
 * - `SELF_RPC_URL`: optional RPC override (default: Forno for the network).
 * - `SELF_RATE_LIMIT_PER_MINUTE` / `SELF_RATE_LIMIT_PER_HOUR`: defaults
 *   60 / 600 — a choice, not a sourced fact.
 */
export function resolveSelfConfig(env: NodeJS.ProcessEnv = process.env): SelfConfig {
  const rawNetwork = (env.SELF_NETWORK ?? "mainnet").toLowerCase();
  if (rawNetwork !== "mainnet" && rawNetwork !== "sepolia") {
    throw new Error(`SELF_NETWORK must be "mainnet" or "sepolia", got ${JSON.stringify(env.SELF_NETWORK)}`);
  }
  const network = rawNetwork as SelfNetwork;
  const sdkNetwork: NetworkName = network === "mainnet" ? "mainnet" : "testnet";
  const net = NETWORKS[sdkNetwork];
  return {
    network,
    sdkNetwork,
    registryAddress: net.registryAddress as Address,
    rpcUrl: env.SELF_RPC_URL ?? net.rpcUrl,
    sybilLimit: parseEnvInt("SELF_SYBIL_LIMIT", env.SELF_SYBIL_LIMIT, 1),
    replayWindowMs: SELF_REPLAY_WINDOW_MS,
    rateLimitPerMinute: parseEnvInt("SELF_RATE_LIMIT_PER_MINUTE", env.SELF_RATE_LIMIT_PER_MINUTE, 60),
    rateLimitPerHour: parseEnvInt("SELF_RATE_LIMIT_PER_HOUR", env.SELF_RATE_LIMIT_PER_HOUR, 600),
    cacheTtlMs: SELF_CACHE_TTL_MS,
  };
}

/** Agent key for an address: zero-padded to 32 bytes (plan §2.3). */
export function agentKeyForAddress(agentAddress: string): Hex {
  return pad(getAddress(agentAddress), { size: 32 });
}

/**
 * Build the SDK signed-request verifier with Ikenga's explicit policy:
 * network, sybil limit, replay protection ON, rate limit ON, 300 s window.
 */
export function buildSelfVerifier(config: SelfConfig = resolveSelfConfig()): SelfAgentVerifier {
  return SelfAgentVerifier.create()
    .network(config.sdkNetwork)
    .registry(config.registryAddress)
    .rpc(config.rpcUrl)
    .sybilLimit(config.sybilLimit)
    .replayProtection(true)
    .rateLimit({ perMinute: config.rateLimitPerMinute, perHour: config.rateLimitPerHour })
    .maxAge(config.replayWindowMs)
    .build();
}

/** Direct on-chain fallback read via viem `eth_call` (no SDK in the path). */
export async function readRegistryDirect(
  agentKey: Hex,
  config: SelfConfig,
  client?: PublicClient,
): Promise<RegistryStatus> {
  const rpc: PublicClient = client ?? createPublicClient({ transport: http(config.rpcUrl) });
  const agentId = (await rpc.readContract({
    address: config.registryAddress,
    abi: FALLBACK_ABI,
    functionName: "getAgentId",
    args: [agentKey],
  })) as bigint;
  if (agentId === 0n) {
    return { agentId, hasHumanProof: false, proofFresh: false, expiresAt: null, agentCount: 0n };
  }
  const [hasHumanProof, proofFresh, expiresAtSecs] = await Promise.all([
    rpc.readContract({
      address: config.registryAddress,
      abi: FALLBACK_ABI,
      functionName: "hasHumanProof",
      args: [agentId],
    }) as Promise<boolean>,
    rpc.readContract({
      address: config.registryAddress,
      abi: FALLBACK_ABI,
      functionName: "isProofFresh",
      args: [agentId],
    }) as Promise<boolean>,
    rpc.readContract({
      address: config.registryAddress,
      abi: FALLBACK_ABI,
      functionName: "proofExpiresAt",
      args: [agentId],
    }) as Promise<bigint>,
  ]);
  // Sybil count: the human nullifier is read only to count agents for the
  // same human. It is used as a call argument here and never returned,
  // logged, or stored anywhere.
  let agentCount = 0n;
  if (config.sybilLimit > 0) {
    const nullifier = (await rpc.readContract({
      address: config.registryAddress,
      abi: FALLBACK_ABI,
      functionName: "getHumanNullifier",
      args: [agentId],
    })) as bigint;
    agentCount = (await rpc.readContract({
      address: config.registryAddress,
      abi: FALLBACK_ABI,
      functionName: "getAgentCountForHuman",
      args: [nullifier],
    })) as bigint;
  }
  return {
    agentId,
    hasHumanProof,
    proofFresh,
    expiresAt: expiresAtSecs > 0n ? new Date(Number(expiresAtSecs) * 1000) : null,
    agentCount,
  };
}

function registryStatusToResult(
  status: RegistryStatus,
  agentAddress: Address,
  checkedAt: string,
  expectedAgentId?: string,
): SelfVerificationResult {
  if (status.agentId === 0n) {
    return { agentId: null, agentAddress, verified: false, reason: "NOT_REGISTERED", checkedAt };
  }
  if (expectedAgentId !== undefined && status.agentId.toString() !== expectedAgentId) {
    return {
      agentId: status.agentId.toString(),
      agentAddress,
      verified: false,
      reason: "AGENT_ID_MISMATCH",
      checkedAt,
    };
  }
  if (!status.hasHumanProof) {
    return {
      agentId: status.agentId.toString(),
      agentAddress,
      verified: false,
      reason: "NO_HUMAN_PROOF",
      checkedAt,
    };
  }
  if (!status.proofFresh) {
    return {
      agentId: status.agentId.toString(),
      agentAddress,
      verified: false,
      reason: "PROOF_EXPIRED",
      expiresAt: status.expiresAt?.toISOString(),
      checkedAt,
    };
  }
  return {
    agentId: status.agentId.toString(),
    agentAddress,
    verified: true,
    reason: "VERIFIED",
    expiresAt: status.expiresAt?.toISOString(),
    checkedAt,
  };
}

/** 1-hour cache, keyed by address + agentId + network. */
const cache = new Map<string, { result: SelfVerificationResult; storedAt: number }>();

export function clearSelfVerificationCache(): void {
  cache.clear();
}

function cacheKey(agentAddress: Address, agentId: string | undefined, config: SelfConfig): string {
  return `${config.network}:${agentAddress.toLowerCase()}:${agentId ?? ""}`;
}

function failResult(
  agentAddress: Address,
  reason: SelfVerificationReason,
  checkedAt: string,
  agentId: string | null = null,
  expiresAt?: string,
): SelfVerificationResult {
  return { agentId, agentAddress, verified: false, reason, expiresAt, checkedAt };
}

/**
 * The CFO gate. Async — this reads the chain.
 *
 * Primary: SDK `verifyAgent` (signature-free on-chain lookup). Fallback:
 * direct viem `eth_call` to the registry (`getAgentId` / `hasHumanProof` /
 * `isProofFresh` / `proofExpiresAt`). Any RPC failure on BOTH paths is
 * `CHAIN_UNREADABLE` — the gate defaults closed, never open.
 *
 * BREAKING CHANGE vs Step 1: this was a sync stub
 * `verifySelfAgentId(agentId: number): SelfVerification`. It is now
 * `async verifySelfAgentId(agentAddress: string, agentId?: string | number)`.
 * Callers must `await` it and pass the agent's address (the old numeric-only
 * signature cannot identify an agent on-chain). See `apps/agent/src/agent.ts`
 * `decide()` — the integration phase must pass the Self result in as an
 * input (`selfVerified`, `selfReason`) instead of calling this inside
 * `decide()`, so `decide()` stays pure.
 */
export async function verifySelfAgentId(
  agentAddress: string,
  agentId?: string | number,
  options: VerifySelfAgentIdOptions = {},
): Promise<SelfVerificationResult> {
  const config = resolveSelfConfig();
  const checkedAt = new Date().toISOString();
  let address: Address;
  try {
    address = getAddress(agentAddress);
  } catch {
    return failResult("0x0000000000000000000000000000000000000000", "INVALID_ADDRESS", checkedAt);
  }
  const expectedAgentId = agentId === undefined ? undefined : String(agentId);
  if (expectedAgentId !== undefined && !/^\d+$/.test(expectedAgentId)) {
    return failResult(address, "INVALID_ADDRESS", checkedAt);
  }

  const key = cacheKey(address, expectedAgentId, config);
  if (!options.forceRefresh) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.storedAt < config.cacheTtlMs) {
      return { ...hit.result, checkedAt };
    }
  }

  const store = (result: SelfVerificationResult): SelfVerificationResult => {
    if (result.reason !== "CHAIN_UNREADABLE") {
      cache.set(key, { result, storedAt: Date.now() });
    }
    return result;
  };

  const agentKey = agentKeyForAddress(address);
  const sdkVerify = options.deps?.sdkVerifyAgent ?? verifyAgent;

  // Primary path: SDK signature-free lookup.
  try {
    const sdkResult = await sdkVerify(agentKey, { network: config.sdkNetwork }, config.rpcUrl);
    if (!sdkResult.verified) {
      if (sdkResult.reason === "PROOF_EXPIRED") {
        return store(
          failResult(address, "PROOF_EXPIRED", checkedAt, null, sdkResult.expiredAt.toISOString()),
        );
      }
      return store(failResult(address, sdkResult.reason, checkedAt));
    }
    if (expectedAgentId !== undefined && sdkResult.agentId.toString() !== expectedAgentId) {
      return store(
        failResult(address, "AGENT_ID_MISMATCH", checkedAt, sdkResult.agentId.toString()),
      );
    }
    // Sybil check (only when verified): count agents for the same human via
    // the direct registry read. The nullifier is handled inside
    // readRegistryDirect and never leaves this module.
    if (config.sybilLimit > 0) {
      try {
        const reader = options.deps?.registryReader ?? readRegistryDirect;
        const status = await reader(agentKey, config);
        if (status.agentCount > BigInt(config.sybilLimit)) {
          return store(
            failResult(address, "SYBIL_LIMIT_EXCEEDED", checkedAt, sdkResult.agentId.toString()),
          );
        }
      } catch {
        return failResult(address, "CHAIN_UNREADABLE", checkedAt);
      }
    }
    return store({
      agentId: sdkResult.agentId.toString(),
      agentAddress: address,
      verified: true,
      reason: "VERIFIED",
      expiresAt: sdkResult.expiresAt?.toISOString(),
      checkedAt,
    });
  } catch {
    // Fall through to the direct on-chain read.
  }

  // Fallback path: direct viem eth_call to the registry.
  try {
    const reader = options.deps?.registryReader ?? readRegistryDirect;
    const status = await reader(agentKey, config);
    const result = registryStatusToResult(status, address, checkedAt, expectedAgentId);
    if (result.verified && config.sybilLimit > 0 && status.agentCount > BigInt(config.sybilLimit)) {
      return store(failResult(address, "SYBIL_LIMIT_EXCEEDED", checkedAt, result.agentId));
    }
    return store(result);
  } catch {
    return failResult(address, "CHAIN_UNREADABLE", checkedAt);
  }
}

/**
 * Verify a *signed* agent request with the configured `SelfAgentVerifier`
 * (replay protection on, rate limit on, 300 s window, explicit sybil limit).
 * Use for inbound agent HTTP requests; the CFO gate uses
 * `verifySelfAgentId` instead (no signed request exists there).
 *
 * The SDK result's `nullifier` is deliberately NOT copied into the return
 * value. Error strings are mapped to distinct reasons: stale timestamps,
 * replays, sybil-over-limit and rate limits are distinguishable.
 */
export async function verifySignedAgentRequest(
  params: {
    signature: string;
    timestamp: string;
    method: string;
    url: string;
    body?: string;
    keytype?: string;
    agentKey?: string;
  },
  options: { deps?: SelfDeps } = {},
): Promise<SelfVerificationResult> {
  const config = resolveSelfConfig();
  const checkedAt = new Date().toISOString();
  const verifier = options.deps?.verifierFactory
    ? options.deps.verifierFactory(config)
    : buildSelfVerifier(config);
  let result: VerificationResult;
  try {
    result = await verifier.verify(params);
  } catch {
    return failResult("0x0000000000000000000000000000000000000000", "CHAIN_UNREADABLE", checkedAt);
  }
  const address = (result.agentAddress ?? "0x0000000000000000000000000000000000000000") as Address;
  if (result.valid) {
    return {
      agentId: result.agentId === 0n ? null : result.agentId.toString(),
      agentAddress: address,
      verified: true,
      reason: "VERIFIED",
      expiresAt: result.proofExpiresAt?.toISOString(),
      checkedAt,
    };
  }
  if (result.retryAfterMs !== undefined) {
    return failResult(address, "RATE_LIMITED", checkedAt, result.agentId === 0n ? null : result.agentId.toString());
  }
  const error = result.error ?? "";
  if (/timestamp/i.test(error)) return failResult(address, "STALE_TIMESTAMP", checkedAt);
  if (/replay/i.test(error)) return failResult(address, "REPLAY_DETECTED", checkedAt);
  if (/human has \d+ agents/i.test(error)) return failResult(address, "SYBIL_LIMIT_EXCEEDED", checkedAt);
  if (/provider/i.test(error)) return failResult(address, "PROVIDER_MISMATCH", checkedAt);
  if (/not verified|not registered/i.test(error)) return failResult(address, "NOT_REGISTERED", checkedAt);
  // NOTE: check "not verified" before age/OFAC — "Agent" contains "age".
  if (/minimum age|ofac|nationality/i.test(error)) return failResult(address, "AGE_OR_OFAC_FAIL", checkedAt);
  if (/expired|proof/i.test(error)) return failResult(address, "PROOF_EXPIRED", checkedAt);
  return failResult(address, "VERIFICATION_FAILED", checkedAt);
}
