/**
 * Real x402 settlement via the Celo facilitator (Step 2, Workstream A,
 * plan §2.1). Uses the @x402 middleware — payloads are NEVER hand-built.
 *
 * Verified facts (against @x402/* 2.32.0 installed 2026-11-21, and a live
 * GET /supported read the same day):
 * - Facilitator: https://api.x402.celo.org (mainnet) /
 *   https://api.x402.sepolia.celo.org (testnet). https://x402.celo.org is
 *   the dashboard only — never point a resource server at it.
 * - Networks eip155:42220 (mainnet), eip155:11142220 (Sepolia). Scheme
 *   `exact` only. Only /settle requires an API key (X-API-Key header);
 *   /verify and /supported are open.
 * - Supported assets (live /supported, 2026-11-21): mainnet USDC, USDT,
 *   USAT (EIP-3009) + wARS, wBRL, wMXN, wCOP, wPEN, wCLP, cNGN (Permit2);
 *   Sepolia USDC only. USDT EIP-712 domain name is "Tether USD",
 *   version "1" — the symbol is NOT the domain name.
 * - Retry header: v2 uses PAYMENT-SIGNATURE; X-PAYMENT is the v1 header
 *   (verified in @x402/core 2.32.0 encodePaymentSignatureHeader — the
 *   plan's UNVERIFIED item (a) resolves in favour of the Celo docs).
 * - cNGN has NO EIP-2612 permit(): never declare eip2612GasSponsoring
 *   for a cNGN route. A first-time cNGN payer approves Permit2
 *   (0x000000000022D473030F116dDEE9F6B43aC78BA3) themselves, paying gas.
 * - Facilitator timeout is 30 s (a CHOICE, not a sourced fact — the Celo
 *   docs publish no timeout; the installed client's default is 90 s).
 * - The live /supported response carries no `feeApplies` field (plan
 *   §2.1 said to check it per asset); pricing (gas at cost + 0.3%) is
 *   therefore not asserted per asset here.
 *
 * Error discipline (project rule, spec.md): after signing, a payment
 * is retried ONLY if the seller says it declined. A post-sign timeout is
 * ambiguous — the facilitator may still have settled — and is NEVER
 * retried. verifyPayment/settlePayment return discriminated results and
 * never throw for facilitator-reported failures; only a programming error
 * (bad config) throws.
 *
 * Secrets: the API key comes from env X402_API_KEY only, via
 * createAuthHeaders. It is never in code, logs, or error messages.
 */
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type FacilitatorClient,
  type FacilitatorConfig,
  type RouteConfig,
  type RoutesConfig,
} from "@x402/core/server";
import {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  SettleError,
  VerifyError,
  type AssetAmount,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SupportedKind,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  BUILDER_CODE,
  builderCodeResourceServerExtension,
  declareBuilderCodeExtension,
  declareEip2612GasSponsoringExtension,
} from "@x402/extensions";
import { isAttributionTag } from "./attribution.js";

// Re-exported so the future server workstream has one import point for the
// Hono middleware. Ikenga has no server yet — nothing here creates one.
export { paymentMiddleware } from "@x402/hono";
export type { FacilitatorClient, PaymentPayload, PaymentRequirements };
// NOTE: @x402 2.32.0 does not publicly export the `PaymentOption` type
// from any subpath, so the option shape is declared structurally below
// (RoutePaymentOption) — it is assignable to the middleware's
// PaymentOption wherever a RoutesConfig is consumed.
export interface RoutePaymentOption {
  scheme: string;
  payTo: string;
  price: AssetAmount;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export const CELO_X402_MAINNET_NETWORK = "eip155:42220" as const;
export const CELO_X402_SEPOLIA_NETWORK = "eip155:11142220" as const;
export const CELO_X402_MAINNET_FACILITATOR_URL = "https://api.x402.celo.org";
export const CELO_X402_SEPOLIA_FACILITATOR_URL = "https://api.x402.sepolia.celo.org";
/** Per-request facilitator timeout. CHOICE (see header): Celo docs publish none. */
export const X402_FACILITATOR_TIMEOUT_MS = 30_000;
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export type CeloX402Network =
  | typeof CELO_X402_MAINNET_NETWORK
  | typeof CELO_X402_SEPOLIA_NETWORK;

const CELO_NETWORKS: readonly string[] = [
  CELO_X402_MAINNET_NETWORK,
  CELO_X402_SEPOLIA_NETWORK,
];

export interface SupportedAsset {
  symbol: string;
  asset: string;
  decimals: number;
  /** EIP-712 domain name — must match the token, never the symbol. */
  name: string;
  /** EIP-712 domain version. */
  version: string;
  transferMethod: "eip3009" | "permit2";
  network: CeloX402Network;
  /**
   * Whether the token implements EIP-2612 permit(), so a route may declare
   * eip2612GasSponsoring for it. False ONLY for cNGN (verified: no permit()).
   */
  supportsEip2612: boolean;
}

/**
 * Supported assets, verified live against facilitator /supported on
 * 2026-11-21 (mainnet + Sepolia). Cross-checked against the
 * @x402/evm 2.32.0 default-asset table for USDC/USDT/USAT/Sepolia-USDC.
 */
export const X402_SUPPORTED_ASSETS: readonly SupportedAsset[] = [
  { symbol: "USDC", asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, name: "USDC", version: "2", transferMethod: "eip3009", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "USDT", asset: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, name: "Tether USD", version: "1", transferMethod: "eip3009", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "USAT", asset: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", decimals: 6, name: "Tether America USD", version: "1", transferMethod: "eip3009", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "wARS", asset: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D", decimals: 18, name: "Peso Argentino", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "wBRL", asset: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0", decimals: 18, name: "Real Brasileño", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "wMXN", asset: "0x337E7456B420bD3481e7FA61fA9850343d610d34", decimals: 18, name: "Peso Mexicano", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "wCOP", asset: "0x8a1D45e102e886510e891d2Ec656a708991e2D76", decimals: 18, name: "Peso Colombiano", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "wPEN", asset: "0x4F34c8b3b5FB6D98Da888F0feA543d4d9C9F2eBE", decimals: 18, name: "Sol Peruano", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "wCLP", asset: "0x61D450a098b6a7f69fC4b98CE68198fe59768651", decimals: 18, name: "Peso Chileno", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: true },
  { symbol: "cNGN", asset: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f", decimals: 6, name: "cNGN", version: "1", transferMethod: "permit2", network: CELO_X402_MAINNET_NETWORK, supportsEip2612: false },
  { symbol: "USDC", asset: "0x01C5C0122039549AD1493B8220cABEdD739BC44E", decimals: 6, name: "USDC", version: "2", transferMethod: "eip3009", network: CELO_X402_SEPOLIA_NETWORK, supportsEip2612: true },
] as const;

export function findSupportedAsset(
  asset: string,
  network: CeloX402Network,
): SupportedAsset | undefined {
  return X402_SUPPORTED_ASSETS.find(
    (a) => a.network === network && a.asset.toLowerCase() === asset.toLowerCase(),
  );
}

function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isAtomicAmount(value: string): boolean {
  return /^\d+$/.test(value);
}

function assertCeloNetwork(network: string): asserts network is CeloX402Network {
  if (!CELO_NETWORKS.includes(network)) {
    throw new Error(
      `Unsupported x402 network ${JSON.stringify(network)}: expected eip155:42220 or eip155:11142220.`,
    );
  }
}

// ------------------------------------------------------------ auth + client

/**
 * Build the createAuthHeaders callback for HTTPFacilitatorClient. Only
 * /settle requires a key, so the key is sent on the settle path only —
 * never on verify/supported. The key value is never logged.
 */
export function createAuthHeaders(apiKey: string): NonNullable<FacilitatorConfig["createAuthHeaders"]> {
  if (!apiKey) throw new Error("X402_API_KEY is empty: cannot build auth headers.");
  return async () => ({ settle: { "X-API-Key": apiKey } });
}

/** createAuthHeaders from env X402_API_KEY; throws when the key is absent. */
export function createAuthHeadersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NonNullable<FacilitatorConfig["createAuthHeaders"]> {
  const key = env.X402_API_KEY;
  if (!key) {
    throw new Error(
      "X402_API_KEY is not set: /settle requires an API key created on the Celo x402 dashboard. " +
        "/verify and /supported work without one.",
    );
  }
  return createAuthHeaders(key);
}

export interface FacilitatorClientOptions {
  /** Facilitator base URL. Defaults from X402_FACILITATOR_URL, else by network. */
  url?: string;
  network?: string;
  /** API key for /settle. Defaults from env X402_API_KEY; may be omitted for verify/supported. */
  apiKey?: string;
  /** Per-request timeout ms. Defaults to X402_FACILITATOR_TIMEOUT_MS (30 s). */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function createFacilitatorClient(
  opts: FacilitatorClientOptions = {},
): HTTPFacilitatorClient {
  const env = opts.env ?? process.env;
  const network = opts.network ?? env.CELO_X402_NETWORK ?? CELO_X402_MAINNET_NETWORK;
  assertCeloNetwork(network);
  const url =
    opts.url ??
    env.X402_FACILITATOR_URL ??
    (network === CELO_X402_SEPOLIA_NETWORK
      ? CELO_X402_SEPOLIA_FACILITATOR_URL
      : CELO_X402_MAINNET_FACILITATOR_URL);
  const apiKey = opts.apiKey ?? env.X402_API_KEY;
  return new HTTPFacilitatorClient({
    url,
    timeoutMs: opts.timeoutMs ?? X402_FACILITATOR_TIMEOUT_MS,
    ...(apiKey ? { createAuthHeaders: createAuthHeaders(apiKey) } : {}),
  });
}

/** The kinds a facilitator supports (networks, schemes, assets). */
export async function getSupportedKinds(
  facilitator: FacilitatorClient = createFacilitatorClient(),
): Promise<SupportedKind[]> {
  return (await facilitator.getSupported()).kinds;
}

// ------------------------------------------------------- resource server

export interface ResourceServerOptions {
  network?: string;
  /** ERC-8021 tag to declare in 402 responses (harmless until Schema 2 is live). */
  attributionTag?: string;
}

/**
 * Build the x402 resource server for a network: exact scheme, registered
 * against the facilitator client. When an attribution tag is given, the
 * builder-code extension is registered so routes can declare it.
 * This does NOT create an HTTP server — pair it with `paymentMiddleware`
 * from @x402/hono when a server exists.
 */
export function createResourceServer(
  facilitator: FacilitatorClient = createFacilitatorClient(),
  opts: ResourceServerOptions = {},
): x402ResourceServer {
  const network = opts.network ?? CELO_X402_MAINNET_NETWORK;
  assertCeloNetwork(network);
  const server = new x402ResourceServer(facilitator).register(
    network as Network,
    new ExactEvmScheme(),
  );
  if (opts.attributionTag !== undefined) {
    if (!isAttributionTag(opts.attributionTag)) {
      throw new Error(
        `Invalid ERC-8021 attribution tag ${JSON.stringify(opts.attributionTag)} for the resource server.`,
      );
    }
    server.registerExtension(builderCodeResourceServerExtension);
  }
  return server;
}

// ------------------------------------------------------- route price config

export interface RoutePrice {
  /** Amount in atomic units, as a decimal integer string. Never "$…". */
  amount: string;
  /** Token contract address. */
  asset: string;
  extra: {
    /** EIP-712 domain name — must match the token, never the symbol. */
    name: string;
    /** EIP-712 domain version. */
    version: string;
    assetTransferMethod?: "eip3009" | "permit2";
  };
}

export interface PaymentOptionInput {
  payTo: string;
  /** Explicit AssetAmount price. A bare "$" price is rejected — it would silently resolve to USDC. */
  price: unknown;
  network?: string;
  scheme?: string;
  maxTimeoutSeconds?: number;
  /** Declare eip2612GasSponsoring for this route (default true, except cNGN where it is forbidden). */
  gasSponsoring?: boolean;
}

/**
 * Build one validated payment option for a route. The price MUST be an
 * explicit {amount, asset, extra:{name, version}} — a bare "$" price, a
 * number, or a missing name/version is rejected, because the EIP-712
 * domain (name/version) must match the token or verification fails.
 * `assetTransferMethod` is derived from the supported-asset table when the
 * caller omits it, so Permit2 assets route to Permit2.
 */
export function buildPaymentOption(input: PaymentOptionInput): RoutePaymentOption {
  const network = input.network ?? CELO_X402_MAINNET_NETWORK;
  assertCeloNetwork(network);
  if (!isAddress(input.payTo)) {
    throw new Error(`payTo must be an EVM address, got ${JSON.stringify(input.payTo)}.`);
  }
  const scheme = input.scheme ?? "exact";
  if (scheme !== "exact") {
    throw new Error(`Unsupported x402 scheme ${JSON.stringify(scheme)}: only "exact" is supported on Celo.`);
  }
  const maxTimeoutSeconds = input.maxTimeoutSeconds ?? 300;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new Error(`maxTimeoutSeconds must be a positive integer, got ${maxTimeoutSeconds}.`);
  }

  const price = input.price;
  if (typeof price === "string" && price.trim().startsWith("$")) {
    throw new Error(
      `Bare dollar price ${JSON.stringify(price)} is not allowed: it silently resolves to USDC. ` +
        `Pass an explicit AssetAmount { amount, asset, extra: { name, version } } instead.`,
    );
  }
  if (typeof price !== "object" || price === null || Array.isArray(price)) {
    throw new Error(
      "Price must be an explicit AssetAmount { amount, asset, extra: { name, version } } — " +
        "a Money price (string/number) is not accepted.",
    );
  }
  const p = price as Partial<RoutePrice> & { extra?: Partial<RoutePrice["extra"]> };
  if (typeof p.amount !== "string" || !isAtomicAmount(p.amount) || BigInt(p.amount) <= 0n) {
    throw new Error(
      `Price amount must be a positive integer string of atomic units, got ${JSON.stringify(p.amount)}.`,
    );
  }
  if (typeof p.asset !== "string" || !isAddress(p.asset)) {
    throw new Error(`Price asset must be an EVM token address, got ${JSON.stringify(p.asset)}.`);
  }
  if (!p.extra || typeof p.extra !== "object") {
    throw new Error("Price extra is required: { name, version } — the token's EIP-712 domain.");
  }
  if (typeof p.extra.name !== "string" || p.extra.name.length === 0) {
    throw new Error("Price extra.name is required: the token's EIP-712 domain name (not the symbol).");
  }
  if (typeof p.extra.version !== "string" || p.extra.version.length === 0) {
    throw new Error("Price extra.version is required: the token's EIP-712 domain version.");
  }
  const method = p.extra.assetTransferMethod;
  if (method !== undefined && method !== "eip3009" && method !== "permit2") {
    throw new Error(`extra.assetTransferMethod must be "eip3009" or "permit2", got ${JSON.stringify(method)}.`);
  }
  const known = findSupportedAsset(p.asset, network);
  const assetTransferMethod = method ?? known?.transferMethod ?? "eip3009";
  // Default: declare gas sponsoring, EXCEPT for assets without EIP-2612
  // (cNGN) — where an explicit `gasSponsoring: true` still throws below.
  const gasSponsoring = input.gasSponsoring ?? known?.supportsEip2612 !== false;
  if (gasSponsoring && known?.supportsEip2612 === false) {
    throw new Error(
      `Cannot declare eip2612GasSponsoring for ${known.symbol}: cNGN has no EIP-2612 permit(). ` +
        `A first-time cNGN payer must approve Permit2 (${PERMIT2_ADDRESS}) themselves.`,
    );
  }
  return {
    scheme,
    payTo: input.payTo,
    price: {
      amount: p.amount,
      asset: p.asset,
      extra: { name: p.extra.name, version: p.extra.version, assetTransferMethod },
    },
    network: network as Network,
    maxTimeoutSeconds,
    extra: { assetTransferMethod },
  };
}

export interface RouteConfigInput {
  method: string;
  path: string;
  payTo: string;
  price: unknown;
  network?: string;
  description?: string;
  /** ERC-8021 tag to declare via the builder-code extension (harmless until Schema 2 is live). */
  attributionTag?: string;
  /** Declare eip2612GasSponsoring (default true, except cNGN where it is forbidden). */
  gasSponsoring?: boolean;
}

/**
 * Build a Hono RoutesConfig entry for one paid route, e.g.
 * `{ "GET /api/tools/quote": { accepts: […], extensions: {…} } }`.
 * The builder-code extension is declared only when a tag is given;
 * eip2612GasSponsoring is declared for EIP-3009/Permit2 routes EXCEPT cNGN.
 */
export function buildRouteConfig(input: RouteConfigInput): Record<string, RouteConfig> {
  const option = buildPaymentOption({
    payTo: input.payTo,
    price: input.price,
    network: input.network,
    gasSponsoring: input.gasSponsoring,
  });
  const price = option.price as RoutePrice;
  const known = findSupportedAsset(
    price.asset,
    (input.network ?? CELO_X402_MAINNET_NETWORK) as CeloX402Network,
  );
  const extensions: Record<string, unknown> = {};
  if (input.attributionTag !== undefined) {
    if (!isAttributionTag(input.attributionTag)) {
      throw new Error(
        `Invalid ERC-8021 attribution tag ${JSON.stringify(input.attributionTag)} for route ${input.method} ${input.path}.`,
      );
    }
    extensions[BUILDER_CODE] = declareBuilderCodeExtension(input.attributionTag);
  }
  const gasSponsoring = input.gasSponsoring ?? true;
  if (gasSponsoring && known?.supportsEip2612 !== false) {
    Object.assign(extensions, declareEip2612GasSponsoringExtension());
  }
  return {
    [`${input.method.toUpperCase()} ${input.path}`]: {
      accepts: [option],
      ...(input.description ? { description: input.description } : {}),
      ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
    },
  };
}

// ------------------------------------------------------- verify / settle

export type VerifyFailureReason =
  | "invalid_signature"
  | "insufficient_balance"
  | "wrong_token"
  | "expired"
  | "timeout"
  | "facilitator_error"
  | "unknown";

export type VerifyPaymentResult =
  | { ok: true; payer?: string }
  | {
      ok: false;
      reason: VerifyFailureReason;
      invalidReason?: string;
      message?: string;
      /** True when the outcome is indeterminate (timeout after signing). Never retry. */
      ambiguous?: boolean;
    };

export type SettleFailureReason =
  | "missing_api_key"
  | "insufficient_credits"
  | "permit2_allowance_required"
  | "timeout"
  | "facilitator_error"
  | "unknown";

export type SettlePaymentResult =
  | { ok: true; transaction: string; network: string; payer?: string; amount?: string }
  | {
      ok: false;
      reason: SettleFailureReason;
      errorReason?: string;
      message?: string;
      statusCode?: number;
      /** True when the outcome is indeterminate (timeout after signing). Never retry. */
      ambiguous?: boolean;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number | undefined {
  if (error instanceof VerifyError || error instanceof SettleError) return error.statusCode;
  const m = messageOf(error).match(/\((\d{3})\)/);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

function reasonStringOf(error: unknown): string | undefined {
  if (error instanceof VerifyError) return error.invalidReason;
  if (error instanceof SettleError) return error.errorReason;
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.invalidReason === "string") return e.invalidReason;
    if (typeof e.errorReason === "string") return e.errorReason;
  }
  return undefined;
}

/** Map a facilitator verify failure to a distinct, stable reason. */
export function classifyVerifyFailure(
  error: unknown,
): Omit<Extract<VerifyPaymentResult, { ok: false }>, "ok"> {
  if (error instanceof FacilitatorTimeoutError) {
    return {
      reason: "timeout",
      message: `Facilitator verify timed out after ${error.timeoutMs} ms — outcome is ambiguous, never retry.`,
      ambiguous: true,
    };
  }
  const reason = reasonStringOf(error) ?? "";
  const msg = messageOf(error);
  const hay = `${reason} ${msg}`.toLowerCase();
  if (/insufficient/.test(hay)) {
    return { reason: "insufficient_balance", invalidReason: reason || undefined, message: msg };
  }
  if (/expired|deadline|valid_before|validbefore/.test(hay)) {
    return { reason: "expired", invalidReason: reason || undefined, message: msg };
  }
  if (/token|asset/.test(hay)) {
    return { reason: "wrong_token", invalidReason: reason || undefined, message: msg };
  }
  if (/signature|authorization|invalid/.test(hay)) {
    return { reason: "invalid_signature", invalidReason: reason || undefined, message: msg };
  }
  if (error instanceof FacilitatorResponseError) {
    return { reason: "facilitator_error", message: msg };
  }
  return { reason: "unknown", invalidReason: reason || undefined, message: msg };
}

/** Map a facilitator settle failure to a distinct, stable reason. */
export function classifySettleFailure(
  error: unknown,
): Omit<Extract<SettlePaymentResult, { ok: false }>, "ok"> {
  if (error instanceof FacilitatorTimeoutError) {
    return {
      reason: "timeout",
      message: `Facilitator settle timed out after ${error.timeoutMs} ms — the settlement may still have completed. Outcome is ambiguous, never retry.`,
      ambiguous: true,
    };
  }
  const status = statusOf(error);
  const reason = reasonStringOf(error) ?? "";
  const msg = messageOf(error);
  const hay = `${reason} ${msg}`.toLowerCase();
  if (status === 401 || /unauthorized|api[-_ ]?key|missing.*key/.test(hay)) {
    return { reason: "missing_api_key", errorReason: reason || undefined, message: msg, statusCode: status };
  }
  if (status === 412 || /permit2_allowance/.test(hay)) {
    return { reason: "permit2_allowance_required", errorReason: reason || undefined, message: msg, statusCode: status };
  }
  if (status === 402 || /insufficient_credits|out of credits|out_of_credits/.test(hay)) {
    return { reason: "insufficient_credits", errorReason: reason || undefined, message: msg, statusCode: status };
  }
  if (error instanceof FacilitatorResponseError) {
    return { reason: "facilitator_error", message: msg, statusCode: status };
  }
  return { reason: "unknown", errorReason: reason || undefined, message: msg, statusCode: status };
}

/**
 * Verify a signed x402 payload against the Celo facilitator.
 * Delegates to facilitator.verify() — the envelope is the middleware's,
 * never hand-built. Returns a discriminated result, never throws for a
 * facilitator-reported failure.
 */
export async function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  facilitator: FacilitatorClient = createFacilitatorClient(),
): Promise<VerifyPaymentResult> {
  try {
    const res = await facilitator.verify(payload, requirements);
    if (res.isValid) return { ok: true, payer: res.payer };
    return { ok: false, ...classifyVerifyFailure(res) };
  } catch (error) {
    return { ok: false, ...classifyVerifyFailure(error) };
  }
}

/**
 * Settle a verified x402 payment via the Celo facilitator (requires
 * X402_API_KEY — without it the facilitator answers 401, surfaced as
 * missing_api_key). Delegates to facilitator.settle(). A timeout result
 * is ambiguous: the settlement may still have completed — NEVER retry it.
 */
export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  facilitator: FacilitatorClient = createFacilitatorClient(),
): Promise<SettlePaymentResult> {
  try {
    const res = await facilitator.settle(payload, requirements);
    if (res.success) {
      return {
        ok: true,
        transaction: res.transaction,
        network: res.network,
        payer: res.payer,
        amount: res.amount,
      };
    }
    return { ok: false, ...classifySettleFailure(res) };
  } catch (error) {
    return { ok: false, ...classifySettleFailure(error) };
  }
}
