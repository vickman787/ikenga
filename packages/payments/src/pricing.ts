/**
 * The cNGN price of a $1 job, fixed at hire time from a live Textile FX
 * preview. Pure — no network, no signing, no rounding surprises.
 *
 * The preview sells exactly $1 of USDT (sellAmount "1000000") and says
 * how much cNGN comes back (buyAmount, atomic units, 6 decimals). The
 * job's price is that amount ROUNDED UP to whole cNGN: the customer
 * never pays a fraction of a naira, and never pays less than $1 of
 * value. The rate is recorded alongside the price (cNGN per $1) so the
 * job page can show what was fixed — and the price never moves
 * afterwards. A later preview at a different rate changes nothing about
 * a job that is already hired; the stored price is the price.
 *
 * Example: a preview of 1,444,067,000 atomic cNGN ($1 at 1,444.067 per
 * $1) fixes the price at 1,445,000,000 atomic = 1,445 whole cNGN.
 */

/** Whole cNGN in atomic units (cNGN has 6 decimals). */
const CNGN_ATOMIC_PER_WHOLE = 1_000_000n;

export interface CngnJobPrice {
  /** Exact cNGN the customer pays, in atomic units (6 decimals). */
  priceAtomic: bigint;
  /** Whole cNGN, for showing ("1445"). */
  priceCngn: string;
  /** cNGN per $1 at the preview, up to 3 decimals ("1444.067"). */
  rateCngnPerUsd: string;
}

/** cNGN per $1 from a preview's buy amount, up to 3 decimals, no trailing zeros. */
export function cngnRatePerUsd(previewBuyAmountAtomic: string): string {
  const buy = parseAtomic(previewBuyAmountAtomic);
  const whole = buy / CNGN_ATOMIC_PER_WHOLE;
  const frac3 = ((buy % CNGN_ATOMIC_PER_WHOLE) / 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac3 ? `${whole}.${frac3}` : whole.toString();
}

/**
 * Fix a $1 job's cNGN price from a live preview's buy amount (atomic
 * cNGN for selling exactly $1 of USDT). Rounds UP to whole cNGN.
 * Throws on a missing, zero, or non-integer amount — a job must never
 * be hired on a guessed price.
 */
export function cngnJobPrice(previewBuyAmountAtomic: string): CngnJobPrice {
  const buy = parseAtomic(previewBuyAmountAtomic);
  if (buy <= 0n) {
    throw new Error("The live naira rate came back empty — the job has no cNGN price yet.");
  }
  const wholeCngn = (buy + CNGN_ATOMIC_PER_WHOLE - 1n) / CNGN_ATOMIC_PER_WHOLE;
  const priceAtomic = wholeCngn * CNGN_ATOMIC_PER_WHOLE;
  return {
    priceAtomic,
    priceCngn: wholeCngn.toString(),
    rateCngnPerUsd: cngnRatePerUsd(previewBuyAmountAtomic),
  };
}

function parseAtomic(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`"${value}" is not an amount in atomic units.`);
  }
  return BigInt(value);
}
