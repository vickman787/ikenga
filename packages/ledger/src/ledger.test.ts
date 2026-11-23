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
