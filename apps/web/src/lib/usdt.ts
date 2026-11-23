/**
 * USDT amounts — plain decimal strings and atomic units (6 decimals).
 * Pure helpers with no imports, so the bill page (a client component)
 * and the server can both use them.
 */

/** USDT as a plain decimal string, from atomic units ("1052341" -> "1.052341"). */
export function usdtAtomicToDecimal(atomic: string): string {
  const v = BigInt(atomic);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Atomic USDT from a plain decimal string ("3.4626" -> 3462600n). At most
 * 6 decimals — USDT has 6 — and no sign, no exponent, no separators. */
export function usdtDecimalToAtomic(decimal: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(decimal)) {
    throw new Error(`"${decimal}" is not a USDT amount — use a plain number with at most 6 decimals.`);
  }
  const [whole, frac = ""] = decimal.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0") || "0");
}

/** "$3.46" — two decimals, for showing an amount in plain words. */
export function formatUsdtDollars(amount: string | bigint): string {
  const decimal = typeof amount === "bigint" ? usdtAtomicToDecimal(amount.toString()) : amount;
  return `$${Number(decimal).toFixed(2)}`;
}
