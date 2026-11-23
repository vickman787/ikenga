/**
 * @ikenga/payments — Celo x402 client and Self Agent ID gate.
 *
 * STEP 1 STATUS: STUB. Nothing here settles a payment, signs anything, or
 * moves funds on any chain. Every real payment function is marked TODO and
 * either returns a stub result or throws. This is deliberate: Step 1 is a
 * skeleton, and a stub that says "stub" is safer than a half-built payment
 * path that looks real.
 *
 * STEP 2 (Workstream C): the Self Agent ID gate is REAL — see ./self.ts.
 * `verifySelfAgentId` is now async and reads the on-chain Self registry
 * (SDK `verifyAgent` + direct viem fallback).
 * STEP 2 (Workstream B): the Textile FX RFQ client is REAL — see ./textile.ts
 * (`requestFxQuote` delegates to it).
 * STEP 2 (Workstream A): x402 verify/settle are REAL — see ./x402.ts
 * (`verifyPayment`/`settlePayment` delegate to the Celo facilitator via
 * the @x402 middleware). Contracts are still placeholders.
 *
 * Verified constants (Celo mainnet, chain 42220) — these are public
 * contract addresses, not secrets:
 * - cNGN  0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f (6 decimals)
 * - USDT  0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e (6 decimals)
 * - Textile FX LimitOrderReactor 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3
 * - ERC-8004 IdentityRegistry 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
 * - x402 facilitator https://api.x402.celo.org, network eip155:42220
 * Gas is payable in stablecoin via CIP-64 fee abstraction.
 */

export const CELO_MAINNET_CHAIN_ID = 42220;
export const CELO_X402_NETWORK = "eip155:42220";
export const CELO_X402_FACILITATOR_URL = "https://api.x402.celo.org";

export const CELO_TOKENS = {
  cNGN: {
    address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
    decimals: 6,
    symbol: "cNGN",
  },
  USDT: {
    address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    decimals: 6,
    symbol: "USDT",
  },
} as const;

export const TEXTILE_FX_LIMIT_ORDER_REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3";
export const ERC8004_IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** Corridors Ikenga supports on Textile FX (Celo). */
export const CORRIDORS = [
  { from: "USDT", to: "cNGN", reactor: TEXTILE_FX_LIMIT_ORDER_REACTOR },
  { from: "cNGN", to: "USDT", reactor: TEXTILE_FX_LIMIT_ORDER_REACTOR },
] as const;

export interface PaymentRequest {
  /** Amount in atomic units (6 decimals for USDT/cNGN), as a string. */
  amount: string;
  asset: keyof typeof CELO_TOKENS;
  payTo: string;
  network: typeof CELO_X402_NETWORK;
  /** ERC-8021 attribution tag — required on every counted transaction. */
  attributionTag: string;
  memo: string;
}

export interface StubResult {
  status: "stub";
  message: string;
}

/**
 * Build an x402 payment request. Pure and safe: it only describes the
 * payment a caller would need to make. It does not sign or send anything.
 */
export function buildPaymentRequest(input: Omit<PaymentRequest, "network">): PaymentRequest {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.payTo)) throw new Error("payTo must be an EVM address");
  if (!/^\d+$/.test(input.amount)) throw new Error("amount must be an integer string of atomic units");
  if (!input.attributionTag.startsWith("celo_")) throw new Error("attributionTag must be a celo_ ERC-8021 tag");
  return { ...input, network: CELO_X402_NETWORK };
}

import {
  settlePayment as settleX402Payment,
  verifyPayment as verifyX402Payment,
  type FacilitatorClient,
  type PaymentPayload,
  type PaymentRequirements,
  type SettlePaymentResult,
  type VerifyPaymentResult,
} from "./x402.js";

/**
 * Verify a signed x402 payload against the Celo facilitator (Step 2,
 * Workstream A — real, delegates to ./x402.ts). Returns a discriminated
 * result; a facilitator-reported failure never throws. Pass a facilitator
 * in tests; otherwise one is built from env (X402_FACILITATOR_URL,
 * X402_API_KEY for /settle).
 */
export async function verifyPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  facilitator?: FacilitatorClient,
): Promise<VerifyPaymentResult> {
  return verifyX402Payment(payload, requirements, facilitator);
}

/**
 * Settle a verified x402 payment via the Celo facilitator (Step 2,
 * Workstream A — real, delegates to ./x402.ts). Requires X402_API_KEY;
 * without it the facilitator answers 401, surfaced as missing_api_key.
 * A timeout result is ambiguous — the settlement may still have
 * completed — and must NEVER be retried.
 */
export async function settlePayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  facilitator?: FacilitatorClient,
): Promise<SettlePaymentResult> {
  return settleX402Payment(payload, requirements, facilitator);
}

export {
  buildPreviewBody,
  buildRfqRequestBody,
  ERC8021_MARKER,
  hasAttributionTag,
  parseFirmQuoteResponse,
  parseLevelsResponse,
  parsePreviewResponse,
  signTakerProof,
  TEXTILE_API_BASE_URL,
  TEXTILE_CELO_REACTOR,
  TEXTILE_CELO_TOKENS,
  TEXTILE_DEFAULT_TIMEOUT_MS,
  TEXTILE_FIRM_QUOTE_TIMEOUT_MS,
  TextileClient,
  TextileError,
} from "./textile.js";
export type {
  FirmQuote,
  FirmQuoteResult,
  LevelPair,
  NoQuoteReason,
  PreviewResult,
  RfqRequestInput,
  RfqStatus,
  SendFn,
  TakerProof,
  TakerSigner,
  TextileClientConfig,
  TextileTx,
  WaitForReceiptFn,
} from "./textile.js";
import { TextileClient } from "./textile.js";
import type { FirmQuoteResult, TakerSigner } from "./textile.js";

/**
 * Request a firm Textile FX RFQ quote for USDT<->cNGN (Step 2, Workstream B).
 * Delegates to `TextileClient.requestFirmQuote` — see packages/payments/src/textile.ts.
 *
 * Async (unlike the Step 1 stub): a firm quote blocks while makers answer
 * (75 s client timeout) and, keyless, signs one TakerControl proof only if
 * the API answers 401 proof_of_control_required. `no_quote` is returned as
 * a value, never thrown. No funds move here — execution is `executeSwap`
 * on the client, with an injected `sendFn`.
 */
export async function requestFxQuote(
  from: "USDT" | "cNGN",
  to: "USDT" | "cNGN",
  amount: string,
  opts: {
    /** Wallet that will sign and broadcast the swap; the quote is bound to it. */
    taker: string;
    apiKey?: string;
    baseUrl?: string;
    /** Keyless signer for the TakerControl proof (viem account/wallet client). */
    signer?: TakerSigner;
    /** Default true: ask Textile to tag transactions.swap (see textile.ts). */
    includeAttribution?: boolean;
  },
): Promise<FirmQuoteResult> {
  const client = new TextileClient({ apiKey: opts.apiKey, baseUrl: opts.baseUrl });
  return client.requestFirmQuote(
    {
      chainId: CELO_MAINNET_CHAIN_ID,
      sellToken: CELO_TOKENS[from].address,
      buyToken: CELO_TOKENS[to].address,
      sellAmount: amount,
      taker: opts.taker,
      includeAttribution: opts.includeAttribution,
    },
    { signer: opts.signer },
  );
}

export {
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
  type SelfConfig,
  type SelfDeps,
  type SelfNetwork,
  type SelfVerificationReason,
  type SelfVerificationResult,
  type VerifySelfAgentIdOptions,
} from "./self.js";

// Step 2, Workstream A — real x402 via the Celo facilitator + sendTagged().
export {
  appendAttribution,
  ATTRIBUTION_TAG_PATTERN,
  isAttributionTag,
  parseAttribution,
  resolveAttributionTag,
} from "./attribution.js";
export { sendTagged, type SendTaggedOptions, type SendTaggedTx, type TaggedTxClient } from "./send.js";
export {
  buildPaymentOption,
  buildRouteConfig,
  CELO_X402_MAINNET_FACILITATOR_URL,
  CELO_X402_SEPOLIA_FACILITATOR_URL,
  CELO_X402_SEPOLIA_NETWORK,
  classifySettleFailure,
  classifyVerifyFailure,
  createAuthHeaders,
  createAuthHeadersFromEnv,
  createFacilitatorClient,
  createResourceServer,
  findSupportedAsset,
  getSupportedKinds,
  PERMIT2_ADDRESS,
  X402_FACILITATOR_TIMEOUT_MS,
  X402_SUPPORTED_ASSETS,
  type CeloX402Network,
  type FacilitatorClientOptions,
  type PaymentOptionInput,
  type ResourceServerOptions,
  type RouteConfigInput,
  type RoutePaymentOption,
  type RoutePrice,
  type SettleFailureReason,
  type SettlePaymentResult,
  type SupportedAsset,
  type VerifyFailureReason,
  type VerifyPaymentResult,
} from "./x402.js";
export { deliverableHashFor, type DeliverableContent } from "./deliverable.js";
export {
  CELO_MAINNET_RPC_URL,
  CELO_SEPOLIA_RPC_URL_DEFAULT,
  createEscrowClient,
  escrowChain,
  escrowRpcUrl,
  readEscrowDeliverableHash,
  readEscrowOnchain,
  verifyTxReceipt,
  type EscrowOnchain,
  type EscrowReadOptions,
  type TxReceiptCheck,
} from "./escrow.js";
export {
  CELO_RPC_URL,
  CELO_SEPOLIA_RPC_URL,
  createBuyerClient,
  createPaymentFetch,
  PAYMENT_RETRY_HEADER_V1,
  PAYMENT_RETRY_HEADER_V2,
  toBuyerSigner,
  X402_BUYER_DEFAULT_SPEND_CAP,
  type BuyerClientOptions,
} from "./x402-client.js";
