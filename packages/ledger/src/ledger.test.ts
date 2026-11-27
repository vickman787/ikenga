import { describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { chainHash, MemoryLedger, PostgresLedger, verifyChain } from "./index.js";

describe("chainHash / verifyChain", () => {
  it("chains deterministically and detects a broken link", () => {
    const genesis = "0".repeat(64);
    const h1 = chainHash(genesis, "quote|first|1000000");
    const h2 = chainHash(h1, "escrow|second|1000000");
    expect(verifyChain([
      { prevHash: genesis, hash: h1, entry: "quote|first|1000000" },
      { prevHash: h1, hash: h2, entry: "escrow|second|1000000" },
    ])).toBe(true);
    expect(verifyChain([
      { prevHash: genesis, hash: h1, entry: "quote|first|1000000" },
      { prevHash: h1, hash: h2, entry: "escrow|TAMPERED|1000000" },
    ])).toBe(false);
  });
});

describe("MemoryLedger", () => {
  it("creates orders and appends a verifiable decision chain", async () => {
    const ledger = new MemoryLedger();
    const order = await ledger.createOrder({
      id: "ord_test_1",
      jobType: "website",
      customerWallet: "0x0000000000000000000000000000000000000001",
      description: "Website for a Lagos bakery",
      status: "draft",
    });
    expect(order.priceMicroUsdc).toBe(1_000_000);
    await ledger.appendDecision({
      id: "dec_1", orderId: order.id, kind: "quote", reason: "priced at $1",
      amountMicroUsdc: 1_000_000, signature: "0xstub", entry: "quote|priced at $1|1000000",
    });
    await ledger.appendDecision({
      id: "dec_2", orderId: order.id, kind: "escrow", reason: "escrow funded",
      amountMicroUsdc: 1_000_000, signature: "0xstub", entry: "escrow|escrow funded|1000000",
    });
    const decisions = await ledger.listDecisions(order.id);
    expect(decisions).toHaveLength(2);
    expect(decisions[1].prevHash).toBe(decisions[0].hash);
    expect(await ledger.verifyOrderChain(order.id)).toBe(true);
    expect(await ledger.getOrder("missing")).toBeNull();
  });
});

describe("MemoryLedger updateOrderEscrow", () => {
  it("records the escrow address and tx hashes, patching only what is given", async () => {
    const ledger = new MemoryLedger();
    await ledger.createOrder({
      id: "ord_esc_1",
      jobType: "website",
      customerWallet: "0x0000000000000000000000000000000000000001",
      description: "Website for a Lagos bakery",
      status: "draft",
    });
    expect((await ledger.getOrder("ord_esc_1"))?.escrowAddress).toBeUndefined();
    const patched = await ledger.updateOrderEscrow("ord_esc_1", {
      escrowAddress: "0x00000000000000000000000000000000000000aa",
      fundTxHash: "0xfund",
    });
    expect(patched?.escrowAddress).toBe("0x00000000000000000000000000000000000000aa");
    expect(patched?.fundTxHash).toBe("0xfund");
    expect(patched?.settleTxHash).toBeUndefined();
    // A second patch leaves the first fields alone.
    const patched2 = await ledger.updateOrderEscrow("ord_esc_1", { settleTxHash: "0xsettle" });
    expect(patched2?.escrowAddress).toBe("0x00000000000000000000000000000000000000aa");
    expect(patched2?.fundTxHash).toBe("0xfund");
    expect(patched2?.settleTxHash).toBe("0xsettle");
    expect(await ledger.updateOrderEscrow("ord_missing", { escrowAddress: "0x00000000000000000000000000000000000000aa" })).toBeNull();
  });
});

describe("PostgresLedger hire + report round-trip (pg-mem)", () => {
  it("stores the hire fields, updates status, and round-trips a report", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_hire",
      jobType: "market-report",
      customerWallet: "0x0000000000000000000000000000000000000003",
      description: "Compare payment options",
      status: "draft",
      priceMicroUsdc: 1_000_000,
      bondMicroUsdc: 100_000,
      cfoAccepted: true,
      cfoReason: "Expected profit 0.1 USDC is at or above the floor.",
      decisionHash: "a".repeat(64),
    });
    const updated = await ledger.updateOrderStatus("ord_pg_hire", "in-progress");
    expect(updated?.status).toBe("in-progress");
    expect(await ledger.updateOrderStatus("ord_missing", "delivered")).toBeNull();
    await ledger.saveReport("ord_pg_hire", {
      report: "", sources: [{ title: "Paystack", url: "https://example.com/paystack" }],
      steps: [{ agent: "Scout", what: "Looked things up.", detail: "" }],
      totalTokens: 0, totalCostUsd: 0, status: "in-progress", revisions: 0,
      deliveredAt: "", stage: 2,
      pages: [{ title: "Paystack", url: "https://example.com/paystack", text: "Paystack charges 1.5%." }],
      plan: "Compare the two.",
    });
    const back = await ledger.getReport("ord_pg_hire");
    expect(back?.stage).toBe(2);
    expect(back?.status).toBe("in-progress");
    expect(back?.pages?.[0].text).toContain("1.5%");
    expect(back?.plan).toBe("Compare the two.");
    // Delivered report overwrites the in-progress state.
    await ledger.saveReport("ord_pg_hire", {
      report: "# Report\n\nPaystack charges 1.5%.", sources: [{ title: "Paystack", url: "https://example.com/paystack" }],
      steps: [{ agent: "Scout", what: "Looked things up.", detail: "", model: "m", tokens: 10, costUsd: 0.001 }],
      totalTokens: 10, totalCostUsd: 0.001, status: "delivered", revisions: 0,
      deliveredAt: "2026-11-22T00:00:00.000Z", stage: 0,
    });
    const delivered = await ledger.getReport("ord_pg_hire");
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.stage).toBe(0);
    expect(delivered?.report).toContain("Paystack charges 1.5%");
    expect(await ledger.getReport("ord_missing")).toBeNull();
    await pool.end();
  });

  it("a second ledger instance over the same database sees the hire and its report", async () => {
    // This is the serverless case: instance A writes, instance B reads.
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const first = new PostgresLedger(pool as never);
    await first.init();
    await first.createOrder({
      id: "ord_pg_fresh",
      jobType: "market-report",
      customerWallet: "0x0000000000000000000000000000000000000003",
      description: "Compare payment options",
      status: "draft",
      bondMicroUsdc: 100_000,
      cfoAccepted: true,
      cfoReason: "ok",
      decisionHash: "b".repeat(64),
    });
    await first.saveReport("ord_pg_fresh", {
      report: "", sources: [], steps: [], totalTokens: 0, totalCostUsd: 0,
      status: "in-progress", revisions: 0, deliveredAt: "", stage: 3,
    });
    // A fresh instance over the same database. It does not re-run init():
    // the schema is already there, and a second init() is a pg-mem quirk
    // (real Postgres re-runs CREATE TABLE IF NOT EXISTS fine).
    const second = new PostgresLedger(pool as never);
    const order = await second.getOrder("ord_pg_fresh");
    expect(order?.description).toBe("Compare payment options");
    expect(order?.bondMicroUsdc).toBe(100_000);
    expect(order?.cfoAccepted).toBe(true);
    expect(order?.decisionHash).toBe("b".repeat(64));
    expect((await second.getReport("ord_pg_fresh"))?.stage).toBe(3);
    await pool.end();
  });
});

describe("PostgresLedger (pg-mem)", () => {
  it("applies the schema and records orders + a decision chain", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_1",
      jobType: "flyers",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Flyers for a market stall",
      status: "draft",
    });
    const d = await ledger.appendDecision({
      id: "dec_pg_1", orderId: "ord_pg_1", kind: "quote", reason: "priced at $1",
      amountMicroUsdc: 1_000_000, signature: "0xstub", entry: "quote|priced at $1|1000000",
    });
    expect(d.prevHash).toBe("0".repeat(64));
    expect((await ledger.listOrders()).map((o) => o.id)).toEqual(["ord_pg_1"]);
    await pool.end();
  });

  it("round-trips the escrow fields through Postgres, patching only what is given", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_esc",
      jobType: "website",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Website",
      status: "draft",
    });
    const fresh = await ledger.getOrder("ord_pg_esc");
    expect(fresh?.escrowAddress).toBeNull();
    expect(fresh?.fundTxHash).toBeNull();
    expect(fresh?.deliverableTxHash).toBeNull();
    expect(fresh?.settleTxHash).toBeNull();
    const patched = await ledger.updateOrderEscrow("ord_pg_esc", {
      escrowAddress: "0x00000000000000000000000000000000000000aa",
      fundTxHash: "0xfund",
    });
    expect(patched?.escrowAddress).toBe("0x00000000000000000000000000000000000000aa");
    expect(patched?.fundTxHash).toBe("0xfund");
    expect(patched?.deliverableTxHash).toBeNull();
    // A second patch leaves the first fields alone, and a fresh instance
    // over the same database sees them (the serverless case).
    await ledger.updateOrderEscrow("ord_pg_esc", {
      deliverableTxHash: "0xdeliver",
      settleTxHash: "0xsettle",
    });
    const second = new PostgresLedger(pool as never);
    const back = await second.getOrder("ord_pg_esc");
    expect(back?.escrowAddress).toBe("0x00000000000000000000000000000000000000aa");
    expect(back?.fundTxHash).toBe("0xfund");
    expect(back?.deliverableTxHash).toBe("0xdeliver");
    expect(back?.settleTxHash).toBe("0xsettle");
    expect(await ledger.updateOrderEscrow("ord_missing", { escrowAddress: "0x00000000000000000000000000000000000000aa" })).toBeNull();
    await pool.end();
  });

  it("round-trips the payment currency and fixed price through Postgres", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_cngn",
      jobType: "market-report",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Report",
      status: "draft",
      payCurrency: "cNGN",
      priceAtomic: "1445000000",
      priceRate: "1444.067",
      tokenAddress: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
      vaultAddress: "0x00000000000000000000000000000000000000c1",
    });
    const back = await ledger.getOrder("ord_pg_cngn");
    expect(back?.payCurrency).toBe("cNGN");
    expect(back?.priceAtomic).toBe("1445000000");
    expect(back?.priceRate).toBe("1444.067");
    expect(back?.tokenAddress).toBe("0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f");
    expect(back?.vaultAddress).toBe("0x00000000000000000000000000000000000000c1");
    // An old row without the fields defaults to a $1 USDT job.
    await ledger.createOrder({
      id: "ord_pg_usdt",
      jobType: "website",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Website",
      status: "draft",
    });
    const old = await ledger.getOrder("ord_pg_usdt");
    expect(old?.payCurrency).toBe("USDT");
    expect(old?.priceAtomic).toBe("1000000");
    // A decision records which currency the money was in.
    await ledger.appendDecision({
      id: "dec_pg_cngn",
      orderId: "ord_pg_cngn",
      kind: "escrow",
      reason: "Customer paid 1,445 cNGN into escrow.",
      amountMicroUsdc: 1_000_000,
      currency: "cNGN",
      signature: "0xikenga-step2",
      entry: "escrow|cNGN|Customer paid 1,445 cNGN into escrow.|1000000",
    });
    const decisions = await ledger.listDecisions("ord_pg_cngn");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.currency).toBe("cNGN");
    expect(await ledger.verifyOrderChain("ord_pg_cngn")).toBe(true);
    await pool.end();
  });

  it("accepts the Investigator's checks in the money log", async () => {
    // Regression: the /run route writes kind 'investigate' for every
    // onchain check, but the decision_log CHECK list did not allow it —
    // so starting any job failed with a constraint error and the page
    // got an empty 500. The schema must accept this kind.
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_inv",
      jobType: "website",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Website",
      status: "escrowed",
    });
    await ledger.appendDecision({
      id: "dec_pg_inv",
      orderId: "ord_pg_inv",
      kind: "investigate",
      reason: "Investigator: The escrow onchain is funded — the $1 is in it.",
      amountMicroUsdc: 0,
      signature: "0xikenga-step2",
      entry: "investigate|job|escrow state|passed|The escrow onchain is funded — the $1 is in it.",
    });
    const decisions = await ledger.listDecisions("ord_pg_inv");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("investigate");
    expect(await ledger.verifyOrderChain("ord_pg_inv")).toBe(true);
    await pool.end();
  });

  it("stores entry_text and detects a tampered decision", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_2",
      jobType: "website",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Website",
      status: "draft",
    });
    await ledger.appendDecision({
      id: "dec_pg_2", orderId: "ord_pg_2", kind: "quote", reason: "priced at $1",
      amountMicroUsdc: 1_000_000, signature: "0xstub", entry: "quote|priced at $1|1000000",
    });
    expect(await ledger.verifyOrderChain("ord_pg_2")).toBe(true);
    // Tamper with the stored entry text — the chain must break.
    await pool.query(`UPDATE decision_log SET entry_text = 'quote|TAMPERED|1000000' WHERE id = 'dec_pg_2'`);
    expect(await ledger.verifyOrderChain("ord_pg_2")).toBe(false);
    await pool.end();
  });

  it("reconciles payments: settled only with a tx hash", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    await ledger.createOrder({
      id: "ord_pg_3",
      jobType: "flyers",
      customerWallet: "0x0000000000000000000000000000000000000002",
      description: "Flyers",
      status: "draft",
    });
    await ledger.recordX402Payment({
      id: "pay_1", orderId: "ord_pg_3", asset: "USDC", amountAtomic: "10000",
      payTo: "0x0000000000000000000000000000000000000002", txHash: "0xabc", status: "settled",
    });
    await ledger.recordX402Payment({
      id: "pay_2", orderId: "ord_pg_3", asset: "USDC", amountAtomic: "10000",
      payTo: "0x0000000000000000000000000000000000000002", txHash: null, status: "verified",
    });
    await ledger.recordX402Payment({
      id: "pay_3", orderId: "ord_pg_3", asset: "USDC", amountAtomic: "10000",
      payTo: "0x0000000000000000000000000000000000000002", txHash: null, status: "ambiguous",
    });
    const recon = await ledger.reconcile("ord_pg_3");
    expect(recon).toEqual({ orderId: "ord_pg_3", settled: 1, unresolved: 1, failed: 1 });
    await pool.end();
  });
});

const BILL_INPUT = {
  id: "bill_test_1",
  payerName: "Ada",
  purpose: "Rice for the shop",
  amountNgn: 5000,
  supplierWallet: "0x00000000000000000000000000000000000000aa",
  deadline: "2026-12-07T09:00:00.000Z",
  minRate: 1400,
  payNow: false,
};

describe("bills (MemoryLedger)", () => {
  it("creates a bill, patches it, and chains verifiable receipt events", async () => {
    const ledger = new MemoryLedger();
    const bill = await ledger.createBill(BILL_INPUT);
    expect(bill.status).toBe("created");
    expect(bill.payNow).toBe(false);
    expect(bill.approvalTxHashes).toEqual([]);
    expect(bill.fundingPayerWallet).toBeNull();
    expect(bill.fundingTxHashes).toEqual([]);
    expect(bill.fundingPaidUsdtAtomic).toBeNull();
    expect(bill.forced).toBe(false);
    await ledger.appendBillEvent({
      id: "bev_1", billId: bill.id, kind: "created", reason: "Bill submitted.",
      rateSeen: null, bpsGap: null, txHash: null, entry: "created|Bill submitted.",
    });
    const patched = await ledger.updateBill(bill.id, {
      status: "watching",
      lastRate: 1444,
      lastDecision: "refuse",
      lastDecisionReason: "Rate 1300 is below the minimum 1400 — refusing.",
      fundingNeededUsdt: "3.47",
      fundingReady: false,
      note: "Waiting for funding.",
    });
    expect(patched?.status).toBe("watching");
    expect(patched?.lastRate).toBe(1444);
    expect(patched?.fundingReady).toBe(false);
    // Funding fields round-trip: the friend's verified payment, attributed to this bill only.
    const funded = await ledger.updateBill(bill.id, {
      fundingPayerWallet: "0x00000000000000000000000000000000000000aa",
      fundingTxHashes: [`0x${"f".repeat(64)}`],
      fundingPaidUsdtAtomic: "3462600",
    });
    expect(funded?.fundingPayerWallet).toBe("0x00000000000000000000000000000000000000aa");
    expect(funded?.fundingTxHashes).toEqual([`0x${"f".repeat(64)}`]);
    expect(funded?.fundingPaidUsdtAtomic).toBe("3462600");
    await ledger.appendBillEvent({
      id: "bev_2", billId: bill.id, kind: "refuse", reason: "Rate below minimum.",
      rateSeen: 1300, bpsGap: -714, txHash: null, entry: "refuse|Rate below minimum.|1300",
    });
    const events = await ledger.listBillEvents(bill.id);
    expect(events).toHaveLength(2);
    expect(events[1].prevHash).toBe(events[0].hash);
    expect(await ledger.verifyBillChain(bill.id)).toBe(true);
    expect(await ledger.getBill("missing")).toBeNull();
    expect((await ledger.listBills()).map((b) => b.id)).toEqual(["bill_test_1"]);
  });

  it("round-trips a pay-now bill with its mode", async () => {
    const ledger = new MemoryLedger();
    const bill = await ledger.createBill({ ...BILL_INPUT, id: "bill_paynow_1", payNow: true });
    expect(bill.payNow).toBe(true);
    expect((await ledger.getBill("bill_paynow_1"))?.payNow).toBe(true);
  });
});

describe("bills (PostgresLedger, pg-mem)", () => {
  it("round-trips a bill and its event chain", async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    const pool = new Pool();
    const ledger = new PostgresLedger(pool as never);
    await ledger.init();
    const bill = await ledger.createBill({ ...BILL_INPUT, id: "bill_pg_1" });
    expect(bill.status).toBe("created");
    await ledger.appendBillEvent({
      id: "bev_pg_1", billId: bill.id, kind: "created", reason: "Bill submitted.",
      rateSeen: null, bpsGap: null, txHash: null, entry: "created|Bill submitted.",
    });
    const patched = await ledger.updateBill(bill.id, {
      status: "converting",
      rfqId: "rfq_1",
      approvalTxHashes: [`0x${"a".repeat(64)}`],
      swapTxHash: `0x${"b".repeat(64)}`,
      forced: false,
    });
    expect(patched?.status).toBe("converting");
    expect(patched?.approvalTxHashes).toEqual([`0x${"a".repeat(64)}`]);
    expect(patched?.swapTxHash).toBe(`0x${"b".repeat(64)}`);
    // A patch with no fields changes nothing but the timestamp.
    expect((await ledger.updateBill(bill.id, {}))?.status).toBe("converting");
    await ledger.appendBillEvent({
      id: "bev_pg_2", billId: bill.id, kind: "swap", reason: "Swapped USDT to cNGN.",
      rateSeen: 1450, bpsGap: 357, txHash: `0x${"b".repeat(64)}`, entry: "swap|Swapped USDT to cNGN.|1450",
    });
    expect(await ledger.verifyBillChain(bill.id)).toBe(true);
    await pool.query(`UPDATE bill_events SET entry_text = 'swap|TAMPERED|1450' WHERE id = 'bev_pg_2'`);
    expect(await ledger.verifyBillChain(bill.id)).toBe(false);
    await pool.end();
  });
});
