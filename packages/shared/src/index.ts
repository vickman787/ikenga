/**
 * @ikenga/shared — shared types, validation schemas and the deterministic
 * CFO pricing function. No I/O, no network, no language model.
 *
 * The CFO never lets a model touch money: pricing is a pure function of the
 * job type, measured tool cost and acceptance history.
 */
import { z } from "zod";

export const JOB_TYPES = ["website", "promo-video", "flyers", "market-report"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_LABELS: Record<JobType, string> = {
  website: "Business website",
  "promo-video": "Promo video",
  flyers: "Flyers & price list",
  "market-report": "Market report",
};

/** Flat customer price for every job, in USDC-equivalent. Traction over profit. */
export const JOB_PRICE_USDC = 1;

export const OrderSchema = z.object({
  id: z.string().min(1),
  jobType: z.enum(JOB_TYPES),
  customerWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an EVM address"),
  description: z.string().min(1).max(500),
  status: z.enum(["draft", "escrowed", "in-progress", "delivered", "accepted", "rejected", "refunded"]),
  createdAt: z.string(),
});
export type Order = z.infer<typeof OrderSchema>;

export const DecisionSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  kind: z.enum([
    "quote",
    "escrow",
    "top-up",
    "accept",
    "reject",
    "refund",
    "refuse",
    // Step 2 kinds (plan §2.5)
    "fx-quote",
    "fx-swap",
    "fx-refuse",
    "self-verify",
    "self-refuse",
    "x402-settle",
  ]),
  reason: z.string().min(1),
  amountUsdc: z.number().nonnegative(),
  prevHash: z.string(),
  hash: z.string(),
  signature: z.string(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** Step 2 — Textile FX quote/swap records (plan §2.2). Amounts are atomic-unit strings. */
export const FxQuoteSchema = z.object({
  rfqId: z.string().min(1),
  orderId: z.string().min(1),
  chainId: z.number().int(),
  sellToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  buyToken: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  sellAmount: z.string().regex(/^\d+$/),
  buyAmount: z.string().regex(/^\d+$/),
  takerPays: z.string().regex(/^\d+$/),
  feeAmount: z.string().regex(/^\d+$/),
  rateRay: z.string().regex(/^\d+$/),
  expiresAt: z.string(),
  orderDeadline: z.string(),
  reactor: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  status: z.enum(["quoted", "submitted", "filled", "no_quote", "expired", "failed"]),
});
export type FxQuote = z.infer<typeof FxQuoteSchema>;

export const FxSwapSchema = FxQuoteSchema.extend({
  approvalTxHash: z.string().nullable(),
  swapTxHash: z.string().nullable(),
  forced: z.boolean().default(false),
});
export type FxSwap = z.infer<typeof FxSwapSchema>;

/** Step 2 — Self Agent ID verification record (plan §2.3). No nullifier field — by design. */
export const SelfVerificationSchema = z.object({
  agentId: z.string().nullable(),
  agentAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  verified: z.boolean(),
  reason: z.string().min(1),
  expiresAt: z.string().optional(),
  checkedAt: z.string(),
});
export type SelfVerification = z.infer<typeof SelfVerificationSchema>;

/**
 * Deterministic CFO pricing.
 *
 * Inputs: measured tool cost for the job type (USDC), and acceptance history
 * (accepted / total quotes). Outputs: the bond the CFO puts up, the expected
 * profit, and whether the job is accepted for work.
 *
 * - p(accept) starts at a 0.8 prior and moves with observed history.
 * - Bond is 10% of the price at zero confidence, rising to 30% at full
 *   confidence (a confident CFO stakes more on delivery).
 * - Expected profit = p*price - cost - (1-p)*bond.
 * - Decline when expected profit is below the floor (-3.50 USDC): the CFO
 *   would rather lose a job than lose more than the floor on it.
 *
 * Pure function: same input, same output, no clock, no I/O.
 */
export interface QuoteInput {
  jobType: JobType;
  /** Measured median tool spend for this job type, in USDC. */
  toolCostUsdc: number;
  /** Past accepted jobs of this type. */
  accepted: number;
  /** Past quoted jobs of this type. */
  quoted: number;
}

export interface Quote {
  jobType: JobType;
  priceUsdc: number;
  toolCostUsdc: number;
  acceptProbability: number;
  bondUsdc: number;
  expectedProfitUsdc: number;
  accepted: boolean;
  reason: string;
}

export const CFO_MIN_EXPECTED_PROFIT_USDC = -3.5;
const PRIOR_ACCEPTS = 4;
const PRIOR_QUOTES = 5; // prior p(accept) = 4/5 = 0.8

export function priceJob(input: QuoteInput): Quote {
  const { jobType, toolCostUsdc, accepted, quoted } = input;
  if (toolCostUsdc < 0) throw new Error("toolCostUsdc must be >= 0");
  if (accepted < 0 || quoted < 0 || accepted > quoted) {
    throw new Error("accepted/quoted history is inconsistent");
  }
  const p = (PRIOR_ACCEPTS + accepted) / (PRIOR_QUOTES + quoted);
  const confidence = quoted === 0 ? 0 : quoted / (quoted + 5);
  const bondRate = 0.1 + 0.2 * confidence;
  const bond = Math.round(JOB_PRICE_USDC * bondRate * 100) / 100;
  const expected = p * JOB_PRICE_USDC - toolCostUsdc - (1 - p) * bond;
  const expectedProfit = Math.round(expected * 100) / 100;
  const ok = expectedProfit >= CFO_MIN_EXPECTED_PROFIT_USDC;
  return {
    jobType,
    priceUsdc: JOB_PRICE_USDC,
    toolCostUsdc,
    acceptProbability: Math.round(p * 1000) / 1000,
    bondUsdc: bond,
    expectedProfitUsdc: expectedProfit,
    accepted: ok,
    reason: ok
      ? `Expected profit ${expectedProfit} USDC is at or above the floor ${CFO_MIN_EXPECTED_PROFIT_USDC} USDC.`
      : `Expected profit ${expectedProfit} USDC is below the floor ${CFO_MIN_EXPECTED_PROFIT_USDC} USDC; job declined.`,
  };
}

export { buildStandaloneSlideshowHtml, type SlideshowSlide } from "./slideshow.js";
