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
