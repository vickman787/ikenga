/**
 * sendTagged() — the ONE chokepoint for all of Ikenga's OWN outbound
 * transactions (Step 2, Workstream A, plan §2.0).
 *
 * Every transaction the agent itself broadcasts goes through here, so that
 * exactly one place is responsible for:
 *   (a) attaching CIP-64 `feeCurrency` (stablecoin gas — viem supports it
 *       natively for Celo chains, so the agent never needs CELO), and
 *   (b) appending the ERC-8021 attribution suffix for the assigned tag.
 *
 * Nothing else in the repo broadcasts a transaction. In particular, x402
 * settlements do NOT go through here and carry NO tag today: the Celo
 * facilitator submits the settlement tx, not Ikenga's wallet (Schema 2
 * role-based tagging is under review upstream and not live). The builder
 * code is still declared in 402 responses via declareBuilderCodeExtension
 * (see ./x402.ts) so it is picked up automatically once live.
 *
 * The tag is resolved by resolveAttributionTag(): an explicit
 * `options.attributionTag` wins, otherwise env IKENGA_ATTRIBUTION_TAG.
 * A missing or malformed tag THROWS — never invent a tag, never send
 * untagged. The tag does not exist yet (assigned at hackathon
 * registration); until it does, this function refuses to send.
 *
 * Signature (exact, for other workstreams):
 *   sendTagged(client, tx: { to: Address, data: Hex, value?: bigint,
 *              feeCurrency?: Address }) => Promise<{ hash: Hex }>
 * `client` is any viem WalletClient on a Celo chain (feeCurrency
 * typechecks for `celo` / `celoSepolia` clients) or any object with a
 * compatible sendTransaction — tests pass a fake. `feeCurrency` is the
 * caller's choice (e.g. USDT); when omitted the tx pays gas in CELO.
 * `value` defaults to undefined (no value transfer) when omitted.
 */
import type { Address, Hex } from "viem";
import { appendAttribution, resolveAttributionTag } from "./attribution.js";

/** Minimal structural type for a viem wallet client (Celo chain). */
export interface TaggedTxClient {
  sendTransaction(args: {
    to: Address;
    data: Hex;
    value?: bigint;
    feeCurrency?: Address;
  }): Promise<Hex>;
}

export interface SendTaggedTx {
  to: Address;
  data: Hex;
  value?: bigint;
  /** CIP-64 fee currency (e.g. USDT). Omit to pay gas in CELO. */
  feeCurrency?: Address;
}

export interface SendTaggedOptions {
  /** Explicit tag override; defaults to env IKENGA_ATTRIBUTION_TAG. */
  attributionTag?: string;
  /** Env source (defaults to process.env) — injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

export async function sendTagged(
  client: TaggedTxClient,
  tx: SendTaggedTx,
  opts: SendTaggedOptions = {},
): Promise<{ hash: Hex }> {
  const tag = resolveAttributionTag(opts.attributionTag, opts.env);
  const data = appendAttribution(tx.data, tag);
  const hash = await client.sendTransaction({
    to: tx.to,
    data,
    ...(tx.value !== undefined ? { value: tx.value } : {}),
    ...(tx.feeCurrency !== undefined ? { feeCurrency: tx.feeCurrency } : {}),
  });
  return { hash };
}
