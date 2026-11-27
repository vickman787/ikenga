import { beforeEach, describe, expect, it } from "vitest";
import { MemoryLedger } from "@ikenga/ledger";
import {
  applyBillUpdate,
  BillInputSchema,
  createBill,
  findBillByFundingTxHash,
  formatNaira,
  formatRate,
  getBill,
  getBillEvents,
  listBills,
  recordBillFunding,
  usdtAtomicToDecimal,
  usdtDecimalToAtomic,
  verifyBillEvents,
} from "./bills.js";
import { setLedgerForTests } from "./jobs.js";

const PAYER = "0x00000000000000000000000000000000000000aa";
const OTHER_PAYER = "0x00000000000000000000000000000000000000bb";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

const VALID = {
  payerName: "Ada",
  purpose: "Rice for the shop",
  amountNgn: 5000,
  supplierWallet: "0x00000000000000000000000000000000000000aa",
  deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  minRate: 1400,
};

beforeEach(() => {
  setLedgerForTests(new MemoryLedger());
});

describe("BillInputSchema", () => {
  it("accepts a good bill", () => {
    expect(BillInputSchema.parse(VALID)).toMatchObject({ amountNgn: 5000, minRate: 1400 });
  });

  it("rejects a bill below the ₦1,500 floor", () => {
    expect(() => BillInputSchema.parse({ ...VALID, amountNgn: 1000 })).toThrow(/₦1,500/);
  });

  it("rejects a bad supplier wallet, a past deadline, and a deadline past 90 days", () => {
    expect(() => BillInputSchema.parse({ ...VALID, supplierWallet: "not-an-address" })).toThrow();
    expect(() => BillInputSchema.parse({ ...VALID, deadline: new Date(Date.now() - 1000).toISOString() })).toThrow(/deadline/i);
    expect(() =>
      BillInputSchema.parse({ ...VALID, deadline: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString() }),
    ).toThrow(/deadline/i);
  });

  it("rejects a missing name, a missing purpose, and a zero minimum rate", () => {
    expect(() => BillInputSchema.parse({ ...VALID, payerName: "  " })).toThrow();
    expect(() => BillInputSchema.parse({ ...VALID, purpose: "" })).toThrow();
    expect(() => BillInputSchema.parse({ ...VALID, minRate: 0 })).toThrow(/lowest rate/);
  });

  it("accepts a pay-now bill and defaults to waiting for a rate", () => {
    expect(BillInputSchema.parse({ ...VALID, payNow: true })).toMatchObject({ payNow: true, minRate: 1400 });
    expect(BillInputSchema.parse(VALID).payNow).toBe(false);
  });
});

describe("createBill / getBill / listBills", () => {
  it("stores the bill and opens its receipt chain with a created event", async () => {
    const bill = await createBill(VALID);
    expect(bill.id.startsWith("bill_")).toBe(true);
    expect(bill.status).toBe("created");
    expect(bill.payNow).toBe(false);
    expect(bill.fundingReady).toBeNull();
    expect(bill.approvalTxHashes).toEqual([]);
    expect((await getBill(bill.id))?.purpose).toBe("Rice for the shop");
    expect((await listBills()).map((b) => b.id)).toEqual([bill.id]);
    const events = await getBillEvents(bill.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("created");
    expect(await verifyBillEvents(bill.id)).toBe(true);
    expect(await getBill("bill_missing")).toBeNull();
  });
});

describe("applyBillUpdate", () => {
  it("patches fields and appends a receipt; unknown bill returns null", async () => {
    const bill = await createBill(VALID);
    const updated = await applyBillUpdate(bill.id, {
      patch: {
        status: "watching",
        lastRate: 1444,
        lastDecision: "refuse",
        lastDecisionReason: "Rate 1444 is below the minimum 1500 — refusing.",
        fundingNeededUsdt: "3.47",
        fundingReady: false,
        note: "Waiting for funding.",
      },
      event: { kind: "refuse", reason: "Rate 1444 is below the minimum 1500 — refusing.", rateSeen: 1444, bpsGap: -373 },
    });
    expect(updated?.status).toBe("watching");
    expect(updated?.lastRate).toBe(1444);
    expect(updated?.fundingNeededUsdt).toBe("3.47");
    const events = await getBillEvents(bill.id);
    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe("refuse");
    expect(events[1].rateSeen).toBe(1444);
    expect(await verifyBillEvents(bill.id)).toBe(true);
    expect(await applyBillUpdate("bill_missing", { patch: { status: "failed" } })).toBeNull();
  });

  it("rejects a bad tx hash in the update", async () => {
    const bill = await createBill(VALID);
    await expect(
      applyBillUpdate(bill.id, { patch: { swapTxHash: "not-a-hash" } }),
    ).rejects.toThrow();
  });
});

describe("usdtDecimalToAtomic / usdtAtomicToDecimal", () => {
  it("round-trips between decimal USDT and atomic units", () => {
    expect(usdtDecimalToAtomic("3.4626")).toBe(3_462_600n);
    expect(usdtDecimalToAtomic("1")).toBe(1_000_000n);
    expect(usdtDecimalToAtomic("0.000001")).toBe(1n);
    expect(usdtAtomicToDecimal("1052341")).toBe("1.052341");
    expect(usdtAtomicToDecimal("1000000")).toBe("1");
    expect(usdtAtomicToDecimal("3462600")).toBe("3.4626");
    expect(usdtAtomicToDecimal(usdtDecimalToAtomic("3.4626").toString())).toBe("3.4626");
  });

  it("rejects more than 6 decimals, signs, and separators", () => {
    expect(() => usdtDecimalToAtomic("1.1234567")).toThrow(/6 decimals/);
    expect(() => usdtDecimalToAtomic("abc")).toThrow();
    expect(() => usdtDecimalToAtomic("-1")).toThrow();
    expect(() => usdtDecimalToAtomic("1,000")).toThrow();
  });
});

describe("recordBillFunding", () => {
  it("records a funding payment and marks the bill funded when it covers the need", async () => {
    const bill = await createBill(VALID);
    await applyBillUpdate(bill.id, { patch: { fundingNeededUsdt: "3.4626" } });
    const funded = await recordBillFunding(bill.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" });
    expect(funded.fundingPayerWallet).toBe(PAYER);
    expect(funded.fundingTxHashes).toEqual([HASH_A]);
    expect(funded.fundingPaidUsdtAtomic).toBe("3462600");
    expect(funded.fundingReady).toBe(true);
    const events = await getBillEvents(bill.id);
    expect(events[events.length - 1].kind).toBe("funded");
    expect(events[events.length - 1].txHash).toBe(HASH_A);
    expect(await verifyBillEvents(bill.id)).toBe(true);
    expect(await findBillByFundingTxHash(HASH_A)).toMatchObject({ id: bill.id });
    expect(await findBillByFundingTxHash(HASH_B)).toBeNull();
  });

  it("tops up when the first payment falls short of the need", async () => {
    const bill = await createBill(VALID);
    await applyBillUpdate(bill.id, { patch: { fundingNeededUsdt: "4" } });
    const first = await recordBillFunding(bill.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" });
    expect(first.fundingReady).toBe(false);
    expect(first.fundingPaidUsdtAtomic).toBe("3462600");
    const second = await recordBillFunding(bill.id, { txHash: HASH_B, payerWallet: PAYER, amountAtomic: "537400" });
    expect(second.fundingReady).toBe(true);
    expect(second.fundingPaidUsdtAtomic).toBe("4000000");
    expect(second.fundingTxHashes).toEqual([HASH_A, HASH_B]);
  });

  it("re-recording the same hash on the same bill is a no-op", async () => {
    const bill = await createBill(VALID);
    await recordBillFunding(bill.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" });
    const again = await recordBillFunding(bill.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" });
    expect(again.fundingTxHashes).toEqual([HASH_A]);
    expect(again.fundingPaidUsdtAtomic).toBe("3462600");
    expect((await getBillEvents(bill.id)).filter((e) => e.kind === "funded")).toHaveLength(1);
  });

  it("rejects a hash already recorded on another bill — two bills can't claim one funding", async () => {
    const first = await createBill(VALID);
    const second = await createBill({ ...VALID, purpose: "Beans for the shop" });
    await recordBillFunding(first.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" });
    await expect(
      recordBillFunding(second.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" }),
    ).rejects.toThrow(/another bill/);
    expect((await getBill(second.id))?.fundingTxHashes).toEqual([]);
  });

  it("rejects a top-up from a different wallet than the first funding", async () => {
    const bill = await createBill(VALID);
    await recordBillFunding(bill.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "1000000" });
    await expect(
      recordBillFunding(bill.id, { txHash: HASH_B, payerWallet: OTHER_PAYER, amountAtomic: "1000000" }),
    ).rejects.toThrow(/different wallet/);
  });

  it("rejects funding a bill that is already paid, and a missing bill", async () => {
    const bill = await createBill(VALID);
    await applyBillUpdate(bill.id, { patch: { status: "paid" } });
    await expect(
      recordBillFunding(bill.id, { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" }),
    ).rejects.toThrow(/already finished/);
    await expect(
      recordBillFunding("bill_missing", { txHash: HASH_A, payerWallet: PAYER, amountAtomic: "3462600" }),
    ).rejects.toThrow(/No bill/);
  });
});

describe("formatting", () => {
  it("formats naira and rates in plain words", () => {
    expect(formatNaira(1500)).toBe("₦1,500");
    expect(formatNaira(5000000)).toBe("₦5,000,000");
    expect(formatRate(1444.5)).toBe("₦1,444.50 per $1");
  });
});
