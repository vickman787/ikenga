/**
 * @ikenga/payments — Textile FX RFQ client (USDT <-> cNGN on Celo).
 *
 * Raw `fetch` + viem. There is no official Textile TS/JS SDK; the RFQ API v2
 * is REST (base https://api.textilecredit.com/v2) — see
 * https://docs.textilecredit.com/api/v2/ and docs/step2-plan.md §2.2.
 *
 * SENDER INJECTION — this module NEVER broadcasts a transaction itself and
 * never imports sendTagged (another workstream owns it). The caller supplies:
 *
 *   sendFn(tx: { to: string; data: string; value: string }) => Promise<string>
 *
 * `sendFn` broadcasts ONE transaction exactly as given and resolves with its
 * tx hash. `executeSwap(quote, sendFn, opts)` uses it for the ERC-20 approval
 * tx(s) AND for `transactions.swap`. The production `sendFn` is expected to
 * be the shared sender (sendTagged: CIP-64 feeCurrency + ERC-8021 tag) — but
 * see ATTRIBUTION below: do NOT tag the swap a second time.
 *
 * ATTRIBUTION (plan risk R-5) — `requestFirmQuote` sends
 * `includeAttribution: true`, so Textile appends its own ERC-8021 tag to
 * `transactions.swap.data` (the tag carries `textile_api` and Textile's
 * account code). The swap calldata must therefore be broadcast EXACTLY as
 * returned — never re-tagged via sendTagged, or the indexer reads only the
 * last tag and one of the two is lost. `executeSwap` records
 * `attributionTagged: boolean` (checked against the ERC-8021 marker) in its
 * result and, when `opts.requireAttribution` is set, refuses to broadcast a
 * swap whose calldata carries no tag. NOTE: the tag Textile appends is
 * Textile's, not Ikenga's `celo_` hackathon code — whether the hackathon
 * indexer credits a Textile-tagged swap to Ikenga is still open (R-5), and
 * `builderCodes` (up to 3, `[a-z0-9_]{1,32}`, never `textile_*`/`tp_*`)
 * can be passed through `requestFirmQuote` if Ikenga obtains a builder code.
 * Keyless/wallet sessions may get `attributionSuffix: null` from the API even
 * with `includeAttribution: true`; that is why the tag check is best-effort
 * by default and only hard-fails under `requireAttribution`.
 *
 * AUTH — two modes, never both (key wins, proof ignored):
 *   1. Partner API key: `Authorization: Bearer <key>` from env
 *      TEXTILE_API_KEY. No `takerProof` is sent.
 *   2. Keyless: no key. The first firm request is sent UNSIGNED; if the API
 *      answers 401 `proof_of_control_required`, this module signs ONE fresh
 *      EIP-712 `TakerControl` challenge with the injected signer and retries
 *      exactly once. Domain { name: "Textile Taker Control", version: "1",
 *      chainId }, type TakerControl { taker, chainId, nonce: bytes32,
 *      issuedAt: uint256 (Unix ms) }. A verified proof earns a ~12h grant,
 *      so later requests usually need no signature at all.
 *
 * QUOTE LIFECYCLE — store `rfqId`, `claimToken`, `encodedOrder` and
 * `signature` from the `request` response IMMEDIATELY: GET /v2/rfq/{id}
 * never replays them. `no_quote` is HTTP 200 with status `no_quote` + a
 * reason enum — it is returned, never thrown. A firm quote holds one of 4
 * outstanding-RFQ slots until fill or `latestOrderDeadline`; cancel/submit
 * do not free it. Quote TTL is 60 s max; `expiresAt` can be sooner.
 *
 * EXECUTION ORDER (executeSwap) — approve `takerPays` (NOT `sellAmount`) to
 * `quote.reactor`; USDT-style tokens reject approve(non-zero -> non-zero),
 * so a standing allowance > 0 is first reset to 0. WAIT for the approval
 * receipt before sending the swap (the reactor pulls the sell token inside
 * `executeBatch`). Re-check `expiresAt` AFTER the approval: past it, refuse
 * and request a new quote. Broadcast `transactions.swap` ONLY — never the
 * top-level `encodedOrder`/`signature` (they are the first order of a
 * possible multi-maker bundle; `transactions.swap` is the `executeBatch` of
 * every signed order). Then POST /v2/rfq/{id}/submit with the hash
 * (idempotent on the same hash, 409 on a different hash).
 *
 * No private keys, mnemonics or API keys live in this file. Keys come from
 * env only (TEXTILE_API_KEY, TEXTILE_API_BASE_URL, IKENGA_FX_TAKER_ADDRESS).
 * No mainnet funds are moved by any test in this package.
 */

import { randomBytes } from "node:crypto";
import { encodeFunctionData, erc20Abi, toHex, type Hex } from "viem";

export const TEXTILE_API_BASE_URL = "https://api.textilecredit.com/v2";
/** Client timeout for POST /v2/rfq/request: worst-case server hold ~70 s. */
export const TEXTILE_FIRM_QUOTE_TIMEOUT_MS = 75_000;
/** Timeout for preview / levels / status / submit / cancel. */
export const TEXTILE_DEFAULT_TIMEOUT_MS = 30_000;
/** Max firm quotes held at once (per API key, or per client IP keyless). */
export const TEXTILE_MAX_OUTSTANDING_RFQS = 4;
/** Default rate-limit tier: 60 requests/minute. */
export const TEXTILE_RATE_LIMIT_PER_MINUTE = 60;

export const CELO_CHAIN_ID = 42220;
/** BSC testnet (97) and Base Sepolia (84532): the only testnet corridors. */
export const TEXTILE_TESTNET_CHAIN_IDS = [97, 84532] as const;

export const TEXTILE_CELO_TOKENS = {
  USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  cNGN: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
} as const;

export const TEXTILE_CELO_REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3";

/** ERC-8021 marker: 16 bytes, 0x8021 repeated (schema-0 suffix trailer). */
export const ERC8021_MARKER = "0x80218021802180218021802180218021";

/** One outbound transaction, exactly as the API returned it. */
export interface TextileTx {
  to: string;
  data: string;
  value: string;
  chainId?: number;
}

/**
 * Broadcasts one transaction and resolves with its hash. Implemented by the
 * caller (production: the shared sendTagged sender). Must NOT mutate the
 * calldata — the swap data may already carry Textile's attribution tag.
 */
export type SendFn = (tx: TextileTx) => Promise<string>;

/** Resolves when the given tx hash has a receipt (viem public client). */
export type WaitForReceiptFn = (txHash: string) => Promise<unknown>;

/** Reads an ERC-20 allowance (viem public client `readContract`). */
export type GetAllowanceFn = (token: string, owner: string, spender: string) => Promise<bigint>;

/** Minimal EIP-712 signer (viem account / wallet client both qualify). */
export interface TakerSigner {
  address: string;
  signTypedData: (args: {
    domain: { name: string; version: string; chainId: number };
    types: { TakerControl: { name: string; type: string }[] };
    primaryType: "TakerControl";
    message: { taker: string; chainId: bigint; nonce: Hex; issuedAt: bigint };
  }) => Promise<Hex>;
}

export type NoQuoteReason = "no_makers_online" | "no_restricted_liquidity" | "no_valid_quote";

export interface TakerProof {
  nonce: string;
  issuedAt: number;
  signature: string;
  scheme?: "eip191";
}

export interface RfqRequestInput {
  chainId: number;
  sellToken: string;
  buyToken: string;
  /** Exact-input, atomic units as a string. Exactly one of sell/buyAmount. */
  sellAmount?: string;
  /** Exact-output, atomic units as a string. Exactly one of sell/buyAmount. */
  buyAmount?: string;
  /** Wallet that will sign and broadcast the swap; the quote is bound to it. */
  taker: string;
  /** Default true: ask Textile to tag transactions.swap (see header). */
  includeAttribution?: boolean;
  /** Up to 3 builder codes, [a-z0-9_]{1,32}; never textile_*/ /* tp_* prefixes. */
  builderCodes?: string[];
  preferredLiquidityWallets?: string[];
  restrictedLiquidityWallets?: string[];
}

export interface FirmQuote {
  rfqId: string;
  /** Returned exactly once — store it; GET /v2/rfq/{id} never replays it. */
  claimToken: string;
  status: "quoted";
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  /** Exactly what leaves the wallet — approve THIS, not sellAmount. */
  takerPays: string;
  rateRay: string;
  /** Accept cutoff — can be sooner than the 60 s TTL. Treat as the deadline. */
  expiresAt: string;
  orderDeadline: string;
  latestOrderDeadline: string;
  reactor: string;
  taker: string;
  /** First order only — NEVER execute directly; use transactions.swap. */
  encodedOrder: string;
  signature: string;
  orders: { encodedOrder: string; signature: string; sellAmount: string; buyAmount: string; feeAmount: string; maker: string }[];
  transactions: { approval?: TextileTx; swap: TextileTx };
  /** Same hex suffix as appended to swap.data, or null for wallet sessions. */
  attributionSuffix?: string | null;
  routing?: Record<string, unknown>;
}

export type FirmQuoteResult =
  | { kind: "quoted"; quote: FirmQuote }
  | {
      kind: "no_quote";
      rfqId?: string;
      claimToken?: string;
      reason: NoQuoteReason;
      availableSellAmount?: string;
      availableBuyAmount?: string;
      reservedUntil?: string;
      retryAfterMs?: number;
    };

export type PreviewResult =
  | {
      kind: "preview";
      sellAmount: string;
      buyAmount: string;
      feeAmount: string;
      takerPays: string;
      rateRay: string;
      availableSellAmount?: string;
      routing?: Record<string, unknown>;
    }
  | {
      kind: "no_quote";
      reason: NoQuoteReason;
      availableSellAmount?: string;
      availableBuyAmount?: string;
      reservedUntil?: string;
      retryAfterMs?: number;
    };

export interface LevelPoint {
  sellAmount: string;
  buyAmount: string;
}

export interface LevelPair {
  sellToken: string;
  buyToken: string;
  sellDecimals: number;
  buyDecimals: number;
  minSellAmount: string;
  maxSellAmount: string;
  levels: LevelPoint[];
}

export interface RfqStatus {
  rfqId: string;
  status: "soliciting" | "quoted" | "no_quote" | "submitted" | "filled" | "failed" | "expired";
  chainId?: number;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  feeAmount?: string;
  taker?: string;
  expiresAt?: string;
  noQuoteReason?: NoQuoteReason | null;
  txHash?: string | null;
  submittedAt?: string;
  filledAt?: string;
  failReason?: string | null;
  createdAt?: string;
}

/** Machine-readable Textile API failure. Branch on `code`/`reason`, not text. */
export class TextileError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  readonly reason?: string;
  readonly required?: string;
  readonly available?: string;
  readonly committed?: string;
  /** ms to wait before retrying (from Retry-After, or a no_quote hint). */
  readonly retryAfterMs?: number;
  readonly requestId?: string;

  constructor(init: {
    message: string;
    httpStatus: number;
    code: string;
    reason?: string;
    required?: string;
    available?: string;
    committed?: string;
    retryAfterMs?: number;
    requestId?: string;
  }) {
    super(init.message);
    this.name = "TextileError";
    this.httpStatus = init.httpStatus;
    this.code = init.code;
    this.reason = init.reason;
    this.required = init.required;
    this.available = init.available;
    this.committed = init.committed;
    this.retryAfterMs = init.retryAfterMs;
    this.requestId = init.requestId;
  }
}

export interface TextileClientConfig {
  baseUrl?: string;
  /** Partner API key (env TEXTILE_API_KEY). When set, no takerProof is sent. */
  apiKey?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ATOMIC_RE = /^\d+$/;
const BUILDER_CODE_RE = /^[a-z0-9_]{1,32}$/;

/** Pure: validate + build the POST /v2/rfq/request (and preview) body. */
export function buildRfqRequestBody(input: RfqRequestInput): Record<string, unknown> {
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("chainId must be a positive integer");
  }
  if (!ADDRESS_RE.test(input.sellToken)) throw new Error("sellToken must be an EVM address");
  if (!ADDRESS_RE.test(input.buyToken)) throw new Error("buyToken must be an EVM address");
  if (input.sellToken.toLowerCase() === input.buyToken.toLowerCase()) {
    throw new Error("sellToken and buyToken must differ");
  }
  const hasSell = input.sellAmount !== undefined;
  const hasBuy = input.buyAmount !== undefined;
  if (hasSell === hasBuy) {
    throw new Error("send exactly one of sellAmount / buyAmount");
  }
  const amount = hasSell ? input.sellAmount! : input.buyAmount!;
  if (!ATOMIC_RE.test(amount) || BigInt(amount) <= 0n) {
    throw new Error("amount must be a positive integer string of atomic units");
  }
  if (input.chainId === CELO_CHAIN_ID) {
    const pair = [input.sellToken.toLowerCase(), input.buyToken.toLowerCase()].sort().join("|");
    const celoPair = [TEXTILE_CELO_TOKENS.cNGN.toLowerCase(), TEXTILE_CELO_TOKENS.USDT.toLowerCase()]
      .sort()
      .join("|");
    if (pair !== celoPair) {
      throw new Error("on Celo (42220) the only supported corridor is USDT <-> cNGN");
    }
  }
  if (input.preferredLiquidityWallets && input.restrictedLiquidityWallets) {
    throw new Error("preferredLiquidityWallets and restrictedLiquidityWallets are mutually exclusive");
  }
  for (const list of [input.preferredLiquidityWallets, input.restrictedLiquidityWallets]) {
    if (list && list.length > 10) throw new Error("at most 10 liquidity wallets may be listed");
    if (list) for (const w of list) if (!ADDRESS_RE.test(w)) throw new Error("liquidity wallet must be an EVM address");
  }
  if (input.builderCodes) {
    if (input.builderCodes.length > 3) throw new Error("at most 3 builderCodes");
    for (const code of input.builderCodes) {
      if (!BUILDER_CODE_RE.test(code)) throw new Error(`builderCode ${code} must match [a-z0-9_]{1,32}`);
      if (code.startsWith("textile_") || code.startsWith("tp_")) {
        throw new Error(`builderCode ${code} uses a reserved prefix (textile_/tp_)`);
      }
    }
  }
  const body: Record<string, unknown> = {
    chainId: input.chainId,
    sellToken: input.sellToken,
    buyToken: input.buyToken,
    ...(hasSell ? { sellAmount: input.sellAmount } : { buyAmount: input.buyAmount }),
  };
  if (input.includeAttribution !== undefined) body.includeAttribution = input.includeAttribution;
  if (input.builderCodes) body.builderCodes = input.builderCodes;
  if (input.preferredLiquidityWallets) body.preferredLiquidityWallets = input.preferredLiquidityWallets;
  if (input.restrictedLiquidityWallets) body.restrictedLiquidityWallets = input.restrictedLiquidityWallets;
  return body;
}

/** Pure: build the preview body (same as request, minus taker/proof). */
export function buildPreviewBody(input: Omit<RfqRequestInput, "taker">): Record<string, unknown> {
  return buildRfqRequestBody(input as RfqRequestInput);
}

/** Pure: sign a fresh TakerControl proof (EIP-712, viem signTypedData). */
export async function signTakerProof(
  signer: TakerSigner,
  chainId: number,
  nowMs: number = Date.now(),
): Promise<TakerProof> {
  const nonce = toHex(randomBytes(32));
  const signature = await signer.signTypedData({
    domain: { name: "Textile Taker Control", version: "1", chainId },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: {
      taker: signer.address,
      chainId: BigInt(chainId),
      nonce,
      issuedAt: BigInt(nowMs),
    },
  });
  return { nonce, issuedAt: nowMs, signature };
}

/**
 * Pure: does this calldata end with an ERC-8021 schema-0 attribution suffix?
 * Layout: [calldata][codes][codesLength 1 byte][schemaId 0x00][magic 16 bytes].
 */
export function hasAttributionTag(data: string): boolean {
  if (typeof data !== "string" || !data.startsWith("0x")) return false;
  const hex = data.toLowerCase();
  const marker = ERC8021_MARKER.toLowerCase();
  if (!hex.endsWith(marker.slice(2))) return false;
  // Byte before the 16-byte magic must be the schema id 0x00.
  const beforeMarker = hex.slice(0, -32);
  return beforeMarker.endsWith("00");
}

/** Pure: parse a firm-quote / no_quote response body. Never throws no_quote. */
export function parseFirmQuoteResponse(json: unknown): FirmQuoteResult {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") throw new Error("Textile response has no data object");
  if (data.status === "no_quote") {
    return {
      kind: "no_quote",
      rfqId: typeof data.rfqId === "string" ? data.rfqId : undefined,
      claimToken: typeof data.claimToken === "string" ? data.claimToken : undefined,
      reason: data.reason as NoQuoteReason,
      availableSellAmount: typeof data.availableSellAmount === "string" ? data.availableSellAmount : undefined,
      availableBuyAmount: typeof data.availableBuyAmount === "string" ? data.availableBuyAmount : undefined,
      reservedUntil: typeof data.reservedUntil === "string" ? data.reservedUntil : undefined,
      retryAfterMs: typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined,
    };
  }
  if (data.status !== "quoted") throw new Error(`unexpected RFQ status: ${String(data.status)}`);
  const quote = data.quote as Record<string, unknown>;
  const transactions = data.transactions as { approval?: TextileTx; swap?: TextileTx };
  if (!quote || !transactions?.swap) throw new Error("quoted RFQ response is missing quote/transactions.swap");
  // takerPays is the amount that leaves the wallet — it must be present.
  if (typeof quote.takerPays !== "string") throw new Error("quoted RFQ response is missing quote.takerPays");
  return {
    kind: "quoted",
    quote: {
      rfqId: data.rfqId as string,
      claimToken: data.claimToken as string,
      status: "quoted",
      sellAmount: quote.sellAmount as string,
      buyAmount: quote.buyAmount as string,
      feeAmount: quote.feeAmount as string,
      takerPays: quote.takerPays as string,
      rateRay: quote.rateRay as string,
      expiresAt: quote.expiresAt as string,
      orderDeadline: quote.orderDeadline as string,
      latestOrderDeadline: quote.latestOrderDeadline as string,
      reactor: quote.reactor as string,
      taker: quote.taker as string,
      encodedOrder: quote.encodedOrder as string,
      signature: quote.signature as string,
      orders: (quote.orders as FirmQuote["orders"]) ?? [],
      transactions: { approval: transactions.approval, swap: transactions.swap as TextileTx },
      attributionSuffix: (data.attributionSuffix as string | null | undefined) ?? null,
      routing: data.routing as Record<string, unknown> | undefined,
    },
  };
}

/** Pure: parse a preview response body (flat fields, status preview/no_quote). */
export function parsePreviewResponse(json: unknown): PreviewResult {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object") throw new Error("Textile preview response has no data object");
  if (data.status === "no_quote") {
    return {
      kind: "no_quote",
      reason: data.reason as NoQuoteReason,
      availableSellAmount: typeof data.availableSellAmount === "string" ? data.availableSellAmount : undefined,
      availableBuyAmount: typeof data.availableBuyAmount === "string" ? data.availableBuyAmount : undefined,
      reservedUntil: typeof data.reservedUntil === "string" ? data.reservedUntil : undefined,
      retryAfterMs: typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined,
    };
  }
  if (data.status !== "preview") throw new Error(`unexpected preview status: ${String(data.status)}`);
  return {
    kind: "preview",
    sellAmount: data.sellAmount as string,
    buyAmount: data.buyAmount as string,
    feeAmount: data.feeAmount as string,
    takerPays: data.takerPays as string,
    rateRay: data.rateRay as string,
    availableSellAmount: typeof data.availableSellAmount === "string" ? data.availableSellAmount : undefined,
    routing: data.routing as Record<string, unknown> | undefined,
  };
}

/** Pure: parse a GET /v2/rfq/levels response body. */
export function parseLevelsResponse(json: unknown): { chainId: number; asOf: string; pairs: LevelPair[] } {
  const data = (json as { data?: Record<string, unknown> } | null)?.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.pairs)) {
    throw new Error("Textile levels response has no data.pairs array");
  }
  return {
    chainId: data.chainId as number,
    asOf: data.asOf as string,
    pairs: data.pairs as LevelPair[],
  };
}

export class TextileClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(config: TextileClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.TEXTILE_API_BASE_URL ?? TEXTILE_API_BASE_URL).replace(/\/$/, "");
    this.apiKey = config.apiKey ?? process.env.TEXTILE_API_KEY ?? undefined;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
  }

  private headers(claimToken?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    if (claimToken) h["X-Rfq-Claim"] = claimToken;
    return h;
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new TextileError({
          message: `Textile request timed out after ${timeoutMs}ms (${path}) — a firm-quote timeout cancels nothing server-side`,
          httpStatus: 0,
          code: "timeout",
        });
      }
      throw err;
    }
    const requestId = res.headers.get("X-Request-Id") ?? undefined;
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  }

  /** Throw a typed TextileError for a non-2xx envelope, else return the body. */
  private throwForError(status: number, json: unknown, headers: Headers, path: string): never {
    const err = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
    const code = typeof err.code === "string" ? err.code : "unknown_error";
    const details = (err.details ?? {}) as Record<string, unknown>;
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    const retryAfter = headers.get("Retry-After");
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    throw new TextileError({
      message: typeof err.message === "string" ? err.message : `Textile ${path} failed with HTTP ${status}`,
      httpStatus: status,
      code,
      reason,
      required: typeof details.required === "string" ? details.required : undefined,
      available: typeof details.available === "string" ? details.available : undefined,
      committed: typeof details.committed === "string" ? details.committed : undefined,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      requestId: headers.get("X-Request-Id") ?? undefined,
    });
  }

  /** Indicative price. Free, no taker, no credential. Not a promise. */
  async previewQuote(input: Omit<RfqRequestInput, "taker">): Promise<PreviewResult> {
    const body = buildPreviewBody(input);
    const { status, json, headers } = await this.requestJson(
      "/rfq/preview",
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      TEXTILE_DEFAULT_TIMEOUT_MS,
    );
    if (status !== 200) this.throwForError(status, json, headers, "/rfq/preview");
    return parsePreviewResponse(json);
  }

  /** Price ladder for a chain: min/max sell amount + up to 9 points per pair. */
  async getLevels(chainId: number): Promise<{ chainId: number; asOf: string; pairs: LevelPair[] }> {
    if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("chainId must be a positive integer");
    const { status, json, headers } = await this.requestJson(
      `/rfq/levels?chainId=${chainId}`,
      { method: "GET", headers: this.headers() },
      TEXTILE_DEFAULT_TIMEOUT_MS,
    );
    if (status !== 200) this.throwForError(status, json, headers, "/rfq/levels");
    return parseLevelsResponse(json);
  }

  /**
   * Firm quote. Blocks while makers answer (75 s client timeout).
   * Keyed: Bearer key, never a proof. Keyless: sent unsigned first; on 401
   * `proof_of_control_required` signs ONE fresh TakerControl proof via
   * `signer` and retries exactly once. `no_quote` is returned, not thrown.
   * 400 `insufficient_funds` throws with required/available/committed.
   * 429 throws with `retryAfterMs` when the server sent Retry-After (rate
   * window); a cap 429 (no Retry-After) means all 4 slots are held — wait
   * for the earliest `latestOrderDeadline` of a live quote instead of
   * hammering. Never retry a 429 in a tight loop.
   */
  async requestFirmQuote(
    input: RfqRequestInput,
    opts: { signer?: TakerSigner } = {},
  ): Promise<FirmQuoteResult> {
    if (!ADDRESS_RE.test(input.taker)) throw new Error("taker must be an EVM address");
    const body: Record<string, unknown> = {
      ...buildRfqRequestBody(input),
      taker: input.taker,
      includeAttribution: input.includeAttribution ?? true,
    };
    const send = async (extra: Record<string, unknown> = {}) =>
      this.requestJson(
        "/rfq/request",
        { method: "POST", headers: this.headers(), body: JSON.stringify({ ...body, ...extra }) },
        TEXTILE_FIRM_QUOTE_TIMEOUT_MS,
      );

    let { status, json, headers } = await send();
    if (status === 401 && !this.apiKey) {
      const err = (json as { error?: Record<string, unknown> } | null)?.error ?? {};
      const details = (err.details ?? {}) as Record<string, unknown>;
      if (details.reason === "proof_of_control_required") {
        if (!opts.signer) {
          throw new TextileError({
            message: "Textile requires a takerProof (proof_of_control_required) but no signer was provided",
            httpStatus: 401,
            code: "unauthorized",
            reason: "proof_of_control_required",
            requestId: headers.get("X-Request-Id") ?? undefined,
          });
        }
        // Re-sign ONCE with a fresh nonce/issuedAt, then send exactly once.
        const takerProof = await signTakerProof(opts.signer, input.chainId, this.now());
        ({ status, json, headers } = await send({ takerProof }));
      }
    }
    if (status !== 200) this.throwForError(status, json, headers, "/rfq/request");
    return parseFirmQuoteResponse(json);
  }

  /** Report the broadcast swap hash. Idempotent on the same hash; 409 on a different one. */
  async submitSwap(rfqId: string, txHash: string, claimToken?: string): Promise<RfqStatus> {
    if (!rfqId) throw new Error("rfqId is required");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 0x-prefixed 32-byte hash");
    const { status, json, headers } = await this.requestJson(
      `/rfq/${encodeURIComponent(rfqId)}/submit`,
      { method: "POST", headers: this.headers(claimToken), body: JSON.stringify({ txHash }) },
      TEXTILE_DEFAULT_TIMEOUT_MS,
    );
    if (status !== 200) this.throwForError(status, json, headers, "/rfq/{id}/submit");
    return (json as { data: RfqStatus }).data;
  }

  /** Status of one RFQ. Never replays encodedOrder/signature/claimToken. */
  async getRfqStatus(rfqId: string, claimToken?: string): Promise<RfqStatus> {
    if (!rfqId) throw new Error("rfqId is required");
    const { status, json, headers } = await this.requestJson(
      `/rfq/${encodeURIComponent(rfqId)}`,
      { method: "GET", headers: this.headers(claimToken) },
      TEXTILE_DEFAULT_TIMEOUT_MS,
    );
    if (status !== 200) this.throwForError(status, json, headers, "/rfq/{id}");
    return (json as { data: RfqStatus }).data;
  }

  /** Release a quoted RFQ's maker inventory. Only works while status is quoted. */
  async cancelQuote(rfqId: string, claimToken?: string): Promise<{ rfqId: string; status: string }> {
    if (!rfqId) throw new Error("rfqId is required");
    const { status, json, headers } = await this.requestJson(
      `/rfq/${encodeURIComponent(rfqId)}/cancel`,
      { method: "POST", headers: this.headers(claimToken), body: JSON.stringify({}) },
      TEXTILE_DEFAULT_TIMEOUT_MS,
    );
    if (status !== 200) this.throwForError(status, json, headers, "/rfq/{id}/cancel");
    return (json as { data: { rfqId: string; status: string } }).data;
  }

  /**
   * Execute a firm quote. Approval + swap are broadcast ONLY through the
   * injected `sendFn` — this module never signs or sends a transaction.
   *
   * Order: (1) approve takerPays to quote.reactor — resetting a standing
   * allowance > 0 to 0 first (USDT-style tokens) — and WAIT for each
   * approval receipt via `opts.waitForReceipt`; skip the approval entirely
   * when the standing allowance already covers takerPays. (2) Re-check
   * expiresAt AFTER the approval; past it, refuse and request a new quote.
   * (3) Broadcast transactions.swap via sendFn. (4) submitSwap(rfqId, hash);
   * a submit failure is reported in the result, never treated as a failed
   * swap (settlement is reconciled on-chain from the filled order).
   *
   * `opts.getAllowance` defaults to "unknown, assume 0" (approval is sent);
   * production callers MUST pass a real allowance reader + receipt waiter
   * backed by a viem public client, or the swap can revert / race.
   */
  async executeSwap(
    quote: FirmQuote,
    sendFn: SendFn,
    opts: {
      waitForReceipt?: WaitForReceiptFn;
      getAllowance?: GetAllowanceFn;
      requireAttribution?: boolean;
      /** Sell token address; required only when the quote has no transactions.approval. */
      sellToken?: string;
      now?: () => number;
    } = {},
  ): Promise<{
    txHash: string;
    approvalTxHashes: string[];
    attributionTagged: boolean;
    submitted: boolean;
    submitError?: string;
    status?: RfqStatus;
  }> {
    const now = opts.now ?? this.now;
    if (quote.status !== "quoted") throw new Error(`cannot execute an RFQ with status ${quote.status}`);
    if (!quote.transactions?.swap) throw new Error("quote has no transactions.swap — never execute encodedOrder directly");
    if (now() >= Date.parse(quote.expiresAt)) {
      throw new TextileError({
        message: `firm quote ${quote.rfqId} expired at ${quote.expiresAt} — request a new quote`,
        httpStatus: 0,
        code: "quote_expired",
      });
    }
    const takerPays = BigInt(quote.takerPays);
    const reactor = quote.reactor;
    // The sell token is the approval tx target; when the quote carries no
    // approval tx the caller must name it (the request response has no
    // sellToken field of its own).
    const sellToken = quote.transactions.approval?.to ?? opts.sellToken;
    if (!sellToken || !ADDRESS_RE.test(sellToken)) {
      throw new Error("executeSwap needs the sell token address (opts.sellToken) — the quote carries no transactions.approval");
    }
    const approvalTxHashes: string[] = [];

    const waitForReceipt = opts.waitForReceipt;
    const needReceiptWait = (hash: string) => {
      if (!waitForReceipt) {
        throw new Error(
          "executeSwap needs opts.waitForReceipt (a viem public-client receipt waiter) — " +
            "broadcasting the swap before the approval confirms risks a revert",
        );
      }
      return waitForReceipt(hash);
    };

    // (1) Approval of takerPays to the reactor.
    const allowance = opts.getAllowance ? await opts.getAllowance(sellToken, quote.taker, reactor) : 0n;
    if (allowance < takerPays) {
      // USDT-style tokens reject approve(non-zero -> non-zero): reset first.
      if (allowance > 0n) {
        const resetData = encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [reactor as Hex, 0n],
        });
        const resetHash = await sendFn({ to: sellToken, data: resetData, value: "0" });
        approvalTxHashes.push(resetHash);
        await needReceiptWait(resetHash);
      }
      // Prefer the API-provided approval calldata; build it only if absent.
      const approvalTx: TextileTx = quote.transactions.approval
        ? { to: quote.transactions.approval.to, data: quote.transactions.approval.data, value: quote.transactions.approval.value ?? "0" }
        : {
            to: sellToken,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [reactor as Hex, takerPays] }),
            value: "0",
          };
      const approvalHash = await sendFn(approvalTx);
      approvalTxHashes.push(approvalHash);
      await needReceiptWait(approvalHash);
    }

    // (2) Re-check the accept cutoff AFTER the approval landed.
    if (now() >= Date.parse(quote.expiresAt)) {
      throw new TextileError({
        message: `firm quote ${quote.rfqId} expired during approval (expiresAt ${quote.expiresAt}) — request a new quote, do not send the swap`,
        httpStatus: 0,
        code: "quote_expired",
      });
    }

    // (3) Attribution check (best-effort unless requireAttribution).
    const attributionTagged = hasAttributionTag(quote.transactions.swap.data);
    if (opts.requireAttribution && !attributionTagged) {
      throw new Error(`firm quote ${quote.rfqId} swap calldata carries no ERC-8021 attribution tag`);
    }

    // Broadcast transactions.swap ONLY — never top-level encodedOrder/signature.
    const swapTx = quote.transactions.swap;
    const txHash = await sendFn({ to: swapTx.to, data: swapTx.data, value: swapTx.value ?? "0" });

    // (4) Report the hash. A failure here does not fail the swap.
    let submitted = false;
    let submitError: string | undefined;
    let status: RfqStatus | undefined;
    try {
      status = await this.submitSwap(quote.rfqId, txHash, quote.claimToken);
      submitted = true;
    } catch (err) {
      submitError = err instanceof Error ? err.message : String(err);
    }
    return { txHash, approvalTxHashes, attributionTagged, submitted, submitError, status };
  }
}
