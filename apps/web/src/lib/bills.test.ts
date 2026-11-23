import { beforeEach, describe, expect, it } from "vitest";
import { MemoryLedger } from "@ikenga/ledger";
import {
  applyBillUpdate,
  BillInputSchema,
  createBill,
  formatNaira,
  formatRate,
  getBill,
  getBillEvents,
  listBills,
  verifyBillEvents,
} from "./bills.js";
import { setLedgerForTests } from "./jobs.js";

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
});

describe("createBill / getBill / listBills", () => {
  it("stores the bill and opens its receipt chain with a created event", async () => {
    const bill = await createBill(VALID);
    expect(bill.id.startsWith("bill_")).toBe(true);
    expect(bill.status).toBe("created");
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

describe("formatting", () => {
  it("formats naira and rates in plain words", () => {
    expect(formatNaira(1500)).toBe("₦1,500");
    expect(formatNaira(5000000)).toBe("₦5,000,000");
    expect(formatRate(1444.5)).toBe("₦1,444.50 per $1");
  });
});
