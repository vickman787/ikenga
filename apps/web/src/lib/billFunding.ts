import { usdtAtomicToDecimal, usdtDecimalToAtomic } from "./usdt";

interface FundingBill {
  status: "created" | "watching" | "converting" | "paid" | "failed";
  fundingPaidUsdtAtomic: string | null;
  fundingNeededUsdt: string | null;
  lastRate: number | null;
  minRate: number;
  deadline: string;
  deadlinePolicy?: "pay_at_deadline" | "keep_waiting";
}
/** Exact six-decimal token amounts for payment controls, with at least two decimals. */
export function formatBillUsdt(amount: bigint): string {
  if (amount < 0n) throw new RangeError("A payment amount cannot be negative.");
  const [whole, fraction = ""] = usdtAtomicToDecimal(amount.toString()).split(".");
  return "$" + whole + "." + fraction.padEnd(2, "0");
}
/** Display eligibility only; actual funding verification and settlement stay on the server. */
export function billFundingView(bill: FundingBill | undefined, now = Date.now()) {
  const paidAtomic = bill?.fundingPaidUsdtAtomic ? BigInt(bill.fundingPaidUsdtAtomic) : 0n;
  const neededAtomic = bill?.fundingNeededUsdt ? usdtDecimalToAtomic(bill.fundingNeededUsdt) : null;
  const remainingAtomic = neededAtomic !== null && neededAtomic > paidAtomic ? neededAtomic - paidAtomic : 0n;
  const fundingStage = bill?.status === "created" || bill?.status === "watching";
  const waitingForTargetRate = paidAtomic > 0n && fundingStage && bill.lastRate !== null &&
    bill.lastRate < bill.minRate && (bill.deadlinePolicy === "keep_waiting" || now < Date.parse(bill.deadline));
  const canPay = fundingStage && remainingAtomic > 0n && !waitingForTargetRate;
  return { paidAtomic, neededAtomic, remainingAtomic, waitingForTargetRate, canPay };
}
