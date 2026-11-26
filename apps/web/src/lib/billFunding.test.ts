import { describe, expect, it } from "vitest";
import { billFundingView, formatBillUsdt } from "./billFunding";
const now = Date.parse("2026-11-26T00:00:00Z");
const bill = { status: "watching" as const, fundingPaidUsdtAtomic: "1041833", fundingNeededUsdt: "1.041907", lastRate: 1439.67, minRate: 1444, deadline: "2026-11-27T23:59:59Z" };
describe("bill funding payment controls", () => {
  it("preserves the real sub-cent shortfall but defers a top-up below the target rate", () => {
    const view = billFundingView(bill, now);
    expect(view.remainingAtomic).toBe(74n);
    expect(formatBillUsdt(view.remainingAtomic)).toBe("$0.000074");
    expect(view.waitingForTargetRate).toBe(true);
    expect(view.canPay).toBe(false);
  });
  it("never enables another payment for an exactly funded or overfunded bill", () => {
    for (const paid of ["1041907", "2000000"]) {
      const view = billFundingView({ ...bill, fundingPaidUsdtAtomic: paid, lastRate: 1444 }, now);
      expect(view.remainingAtomic).toBe(0n);
      expect(view.canPay).toBe(false);
    }
  });
  it("permits only a genuine shortfall once the target is met, or at the existing deadline", () => {
    expect(billFundingView({ ...bill, lastRate: 1444 }, now).canPay).toBe(true);
    expect(billFundingView(bill, Date.parse(bill.deadline)).canPay).toBe(true);
    expect(billFundingView(bill, Date.parse(bill.deadline) - 1).canPay).toBe(false);
  });
  it("allows the initial funding while the agent waits for the payer's target", () => {
    const view = billFundingView({ ...bill, fundingPaidUsdtAtomic: null }, now);
    expect(view.remainingAtomic).toBe(1041907n);
    expect(view.canPay).toBe(true);
  });
  it("does not request funding without a quote, or while processing, completed or failed", () => {
    expect(billFundingView(undefined, now).canPay).toBe(false);
    expect(billFundingView({ ...bill, fundingNeededUsdt: null }, now).canPay).toBe(false);
    for (const status of ["converting", "paid", "failed"] as const) {
      expect(billFundingView({ ...bill, status, lastRate: 1444 }, now).canPay).toBe(false);
    }
  });
});
describe("exact bill payment labels", () => {
  it.each([[0n,"$0.00"],[1n,"$0.000001"],[74n,"$0.000074"],[9999n,"$0.009999"],[10000n,"$0.01"],[1041833n,"$1.041833"],[1000000n,"$1.00"],[9007199254740993123456n,"$9007199254740993.123456"]])("formats %s atomic units without hiding precision",(amount,label)=>{
    expect(formatBillUsdt(amount)).toBe(label);
  });
  it("refuses a negative payment label",()=>expect(()=>formatBillUsdt(-1n)).toThrow());
});

