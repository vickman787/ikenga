import { TextileClient } from "@ikenga/payments";
import { MIN_BILL_NGN, MAX_BILL_NGN } from "./billConstants";
import { usdtAtomicToDecimal } from "./usdt";

/** Exact-output, fee-inclusive preview. No signature or firm RFQ reservation. */
export async function previewBill(amountNgn: number) {
  if (!Number.isInteger(amountNgn) || amountNgn < MIN_BILL_NGN || amountNgn > MAX_BILL_NGN) {
    throw new Error("Enter a supported whole-naira bill amount before requesting a quote.");
  }
  const buyAmount = (BigInt(amountNgn) * 1_000_000n).toString();
  const quote = await new TextileClient().previewQuote({
    chainId: 42220,
    sellToken: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    buyToken: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
    buyAmount,
  });
  if (quote.kind !== "preview" || BigInt(quote.takerPays) <= 0n || quote.buyAmount !== buyAmount) {
    throw new Error("No matching live quote is available. Try again shortly.");
  }
  const rate = Number(BigInt(buyAmount) * 1_000_000n / BigInt(quote.takerPays)) / 1_000_000;
  return {
    amountNgn, rate, neededUsdt: usdtAtomicToDecimal(quote.takerPays),
    minimumRate: Math.floor(rate * 0.995 * 1_000_000) / 1_000_000,
    checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
}
