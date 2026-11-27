/**
 * Ikenga FX leg — pure decision function (plan §2.2).
 *
 * The agent converts USDT → cNGN for a named naira obligation only at or
 * above the minimum rate the user names. Below it, it refuses and writes a
 * receipt for the concession it avoided. At the deadline it converts
 * anyway and marks the fill forced, recording the concession in bps.
 *
 * Pure: quote in, decision out. No I/O, no clock except what is passed in.
 * Rates are cNGN per 1 USDT as plain numbers (e.g. 1444 = ₦1,444 per $1).
 * Textile quotes carry rateRay (1e27-scaled); convert before calling here.
 */

export interface FxQuoteInput {
  /** Firm quote rate, cNGN per 1 USDT. */
  rate: number;
  /** Quote expiry (ISO). The quote must still be valid at `now`. */
  expiresAt: string;
}

export interface FxDecisionInput {
  /** Naira obligation, in whole cNGN (e.g. 500000 = ₦500,000). */
  obligationNaira: number;
  /** Minimum acceptable rate, cNGN per 1 USDT. */
  minRate: number;
  deadlinePolicy?: "pay_at_deadline" | "keep_waiting";
  /** Obligation deadline (ISO). */
  deadline: string;
  /** Current time (ISO) — injected, never read from the clock here. */
  now: string;
  /** Firm quote, when one was obtained. Absent = no quote yet. */
  quote?: FxQuoteInput | null;
}

export type FxAction = "convert" | "refuse" | "force-convert" | "wait";

export interface FxDecision {
  action: FxAction;
  reason: string;
  /** Rate seen, when a quote exists. */
  rateSeen?: number;
  /** Gap in basis points between the rate seen and the minimum (negative = below). */
  bpsGap?: number;
  /** Naira the refusal saved vs converting at the rate seen (approx, whole cNGN). */
  nairaSaved?: number;
}

/** Basis points between a seen rate and the minimum rate. */
export function bpsGap(rateSeen: number, minRate: number): number {
  if (minRate <= 0) throw new Error("minRate must be > 0");
  return Math.round(((rateSeen - minRate) / minRate) * 10_000);
}

export function decideFx(input: FxDecisionInput): FxDecision {
  const { obligationNaira, minRate, deadline, now, quote } = input;
  if (obligationNaira <= 0) throw new Error("obligationNaira must be > 0");
  if (minRate <= 0) throw new Error("minRate must be > 0");
  const nowMs = Date.parse(now);
  const deadlineMs = Date.parse(deadline);
  if (Number.isNaN(nowMs) || Number.isNaN(deadlineMs)) throw new Error("now/deadline must be ISO timestamps");
  const pastDeadline = nowMs >= deadlineMs && input.deadlinePolicy !== "keep_waiting";

  if (!quote) {
    return pastDeadline
      ? { action: "force-convert", reason: "Deadline reached with no firm quote — convert at the best available rate and record the concession." }
      : { action: "wait", reason: "No firm quote yet — keep watching Textile FX." };
  }
  if (Date.parse(quote.expiresAt) <= nowMs) {
    return pastDeadline
      ? { action: "force-convert", reason: "Firm quote expired and the deadline is reached — re-quote and convert, recording the concession." }
      : { action: "wait", reason: "Firm quote expired — request a fresh quote." };
  }
  const gap = bpsGap(quote.rate, minRate);
  if (quote.rate >= minRate) {
    return {
      action: "convert",
      reason: `Rate ${quote.rate} cNGN/USDT is at or above the minimum ${minRate}.`,
      rateSeen: quote.rate,
      bpsGap: gap,
    };
  }
  if (pastDeadline) {
    return {
      action: "force-convert",
      reason: `Deadline reached and the rate ${quote.rate} is below the minimum ${minRate} — converting anyway and recording the ${-gap} bps concession.`,
      rateSeen: quote.rate,
      bpsGap: gap,
    };
  }
  // Refusal receipt: what converting now would have cost vs waiting.
  const usdtNeeded = obligationNaira / quote.rate;
  const nairaAtMin = usdtNeeded * minRate;
  return {
    action: "refuse",
    reason: `Rate ${quote.rate} cNGN/USDT is below the minimum ${minRate} — refusing and recording the concession avoided.`,
    rateSeen: quote.rate,
    bpsGap: gap,
    nairaSaved: Math.max(0, Math.round(nairaAtMin - obligationNaira)),
  };
}
