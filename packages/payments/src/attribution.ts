/**
 * ERC-8021 attribution tags for Ikenga's own transactions (Step 2, Workstream A).
 *
 * Verified facts (Celo docs + @celo/attribution-tags 0.5.0, BUILDERS.md):
 * - A tag is `celo_` + 12 hex chars, assigned at hackathon registration.
 *   A self-derived code is silently never credited — credit is gated at
 *   the registry/indexer layer. NEVER invent a tag.
 * - Schema 0 suffix layout: [codes][codesLength 1 byte][schemaId 0x00]
 *   [magic 16 bytes 0x8021…]. The EVM discards trailing bytes, so execution
 *   semantics do not change.
 * - x402 settlements carry NO tag today: the facilitator submits the
 *   settlement tx, not Ikenga's wallet. Tag the agent's OWN transactions
 *   (ERC-8004 registration, Textile approval + swap, cNGN payout,
 *   escrow/vault calls) — that is what sendTagged() does — AND the
 *   customer's own transactions in the hire flow (escrow deploy, approve,
 *   fund, accept, reject), which the browser tags with appendAttribution()
 *   in apps/web/src/lib/contracts.ts. The customer's payment only counts
 *   as Ikenga work when it carries the tag.
 *
 * The tag itself comes from env IKENGA_ATTRIBUTION_TAG (see
 * resolveAttributionTag). Until the hackathon assigns a real code, every
 * sendTagged() call throws rather than sending an untagged transaction.
 */
import {
  ERC_8021_MARKER,
  fromDataSuffix,
  toDataSuffix,
  type DecodedSuffix,
} from "@celo/attribution-tags";
import type { Hex } from "viem";

export { ERC_8021_MARKER };
export type { DecodedSuffix };

/** Verified tag format: `celo_` + 12 hex chars. */
export const ATTRIBUTION_TAG_PATTERN = /^celo_[0-9a-fA-F]{12}$/;

export function isAttributionTag(code: string): boolean {
  return ATTRIBUTION_TAG_PATTERN.test(code);
}

const MARKER_HEX = ERC_8021_MARKER.slice(2); // 32 hex chars, no 0x

/** Split full calldata into { body, suffix } when it ends with a Schema 0/2 tag. */
function splitSuffix(data: Hex): { body: Hex; suffix: Hex } | null {
  if (!data.startsWith("0x") || data.length < 2 + 36) return null;
  if (!data.endsWith(MARKER_HEX)) return null;
  // Layout (hex chars, from the end): [magic 32][schemaId 2][codesLength 2][codes…]
  const magicStart = data.length - 32;
  const codesLength = Number.parseInt(data.slice(magicStart - 4, magicStart - 2), 16);
  if (!Number.isInteger(codesLength) || codesLength <= 0) return null;
  const codesStart = magicStart - 4 - codesLength * 2;
  if (codesStart < 2) return null;
  return {
    body: data.slice(0, codesStart) as Hex,
    suffix: `0x${data.slice(codesStart)}` as Hex,
  };
}

/**
 * Append the ERC-8021 Schema 0 suffix for `code` to `data`.
 * If `data` already carries a tag, the codes are merged into one suffix
 * (matching withAttribution behaviour) instead of stacking a second suffix.
 */
export function appendAttribution(data: Hex, code: string): Hex {
  if (!isAttributionTag(code)) {
    throw new Error(
      `Invalid ERC-8021 attribution tag ${JSON.stringify(code)}: expected "celo_" + 12 hex chars. ` +
        `Never invent a tag — use the code assigned at hackathon registration.`,
    );
  }
  const existing = splitSuffix(data);
  if (existing) {
    const parsed = parseAttribution(data);
    // A Schema 2 (role-based) tag is left as is — never re-encoded as Schema 0.
    if (!parsed || parsed.schemaId !== 0) return data;
    const codes = [...parsed.codes];
    if (codes.includes(code)) return data;
    const merged = toDataSuffix([...codes, code]);
    return `${existing.body}${merged.slice(2)}` as Hex;
  }
  const suffix = toDataSuffix(code);
  return `${data}${suffix.slice(2)}` as Hex;
}

/**
 * Decode the attribution tag from full calldata. Returns null when the
 * calldata carries no tag (or the suffix is malformed) — never throws.
 */
export function parseAttribution(data: Hex): DecodedSuffix | null {
  const split = splitSuffix(data);
  if (!split) return null;
  try {
    return fromDataSuffix(split.suffix);
  } catch {
    return null;
  }
}

/**
 * The calldata with the attribution suffix removed — the call itself,
 * exactly as it was before tagging. Returns the data unchanged when it
 * carries no tag. A tagged USDT transfer strips back to the exact
 * transfer(to, amount) call, so the payment can be verified against
 * what was meant to be sent.
 */
export function stripAttribution(data: Hex): Hex {
  const split = splitSuffix(data);
  return split ? split.body : data;
}

/**
 * Resolve the attribution tag: an explicit value wins, otherwise env
 * IKENGA_ATTRIBUTION_TAG. Throws when absent or malformed — a missing tag
 * must fail loudly, never fall back to an invented code or an untagged tx.
 */
export function resolveAttributionTag(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tag = explicit ?? env.IKENGA_ATTRIBUTION_TAG;
  if (!tag) {
    throw new Error(
      "IKENGA_ATTRIBUTION_TAG is not set: no ERC-8021 tag is configured, so no " +
        "transaction can be sent. Set it to the code assigned at hackathon " +
        "registration (celo_ + 12 hex chars). Never invent a tag.",
    );
  }
  if (!isAttributionTag(tag)) {
    throw new Error(
      `Invalid ERC-8021 attribution tag ${JSON.stringify(tag)}: expected "celo_" + 12 hex chars.`,
    );
  }
  return tag;
}
