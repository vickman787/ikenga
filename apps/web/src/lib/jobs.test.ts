import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MemoryLedger, PostgresLedger } from "@ikenga/ledger";
import {
  createHire,
  ESTIMATED_TOOL_COST_USDC,
  getHire,
  getReport,
  HireInputSchema,
  listHires,
  setHireStatus,
  setLedgerForTests,
  setReport,
} from "./jobs.js";

describe("HireInputSchema", () => {
  it("accepts a valid hire and rejects a bad wallet", () => {
    expect(
      HireInputSchema.safeParse({
        jobType: "website",
        description: "A site for my shop",
        customerWallet: "0x0000000000000000000000000000000000000001",
      }).success,
    ).toBe(true);
    expect(
      HireInputSchema.safeParse({
        jobType: "website",
        description: "A site",
        customerWallet: "not-a-wallet",
      }).success,
    ).toBe(false);
    expect(
      HireInputSchema.safeParse({ jobType: "rocket", description: "x", customerWallet: "0x0000000000000000000000000000000000000001" })
        .success,
    ).toBe(false);
  });
});

describe("createHire (Step 1 hire flow)", () => {
  it("creates a $1 draft order with a CFO quote and a decision hash", async () => {
    const before = (await listHires()).length;
    const hire = await createHire({
      jobType: "flyers",
      description: "Flyers for a market stall",
      customerWallet: "0x0000000000000000000000000000000000000002",
    });
    expect(hire.status).toBe("draft");
    expect(hire.priceUsdc).toBe(1);
    expect(hire.bondUsdc).toBeGreaterThan(0);
    expect(hire.cfoAccepted).toBe(true);
    expect(hire.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await listHires()).length).toBe(before + 1);
    expect(await getHire(hire.id)).toMatchObject({ id: hire.id, priceUsdc: 1 });
    expect(await getReport(hire.id)).toBeNull();
    expect(ESTIMATED_TOOL_COST_USDC.flyers).toBe(0.4);
  });

  it("status changes and reports persist through the ledger", async () => {
    const hire = await createHire({
      jobType: "market-report",
      description: "Compare payment options",
      customerWallet: "0x0000000000000000000000000000000000000002",
    });
    await setReport(hire.id, {
      report: "", sources: [], steps: [], totalTokens: 0, totalCostUsd: 0,
      status: "in-progress", revisions: 0, deliveredAt: "", stage: 2,
    });
    expect((await getReport(hire.id))?.stage).toBe(2);
    const updated = await setHireStatus(hire.id, "delivered");
    expect(updated?.status).toBe("delivered");
    expect((await getHire(hire.id))?.status).toBe("delivered");
  });
});

// A real Postgres (not pg-mem): the hire made on one connection must be
// found by a second, fresh connection — the serverless case. Run with:
//   IKENGA_TEST_DATABASE_URL=postgres://ikenga:ikenga@localhost:5433/ikenga pnpm --filter @ikenga/web test
const PG_URL = process.env.IKENGA_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("Postgres hire/report round-trip (gated: IKENGA_TEST_DATABASE_URL)", () => {
  it("a hire made on one ledger is found by a fresh ledger, with its report", async () => {
    const poolA = new Pool({ connectionString: PG_URL });
    const ledgerA = new PostgresLedger(poolA as never);
    await ledgerA.init();
    setLedgerForTests(ledgerA);
    try {
      const hire = await createHire({
        jobType: "market-report",
        description: "Compare payment options for my shop",
        customerWallet: "0x0000000000000000000000000000000000000004",
      });
      await setReport(hire.id, {
        report: "", sources: [{ title: "Paystack", url: "https://example.com/paystack" }],
        steps: [{ agent: "Scout", what: "Looked things up.", detail: "" }],
        totalTokens: 0, totalCostUsd: 0, status: "in-progress", revisions: 0,
        deliveredAt: "", stage: 2,
        pages: [{ title: "Paystack", url: "https://example.com/paystack", text: "Paystack charges 1.5%." }],
      });
      // Fresh instance: a new pool and a new ledger, no shared memory.
      const poolB = new Pool({ connectionString: PG_URL });
      const ledgerB = new PostgresLedger(poolB as never);
      await ledgerB.init();
      setLedgerForTests(ledgerB);
      const found = await getHire(hire.id);
      expect(found?.description).toBe("Compare payment options for my shop");
      expect(found?.priceUsdc).toBe(1);
      expect(found?.bondUsdc).toBeGreaterThan(0);
      expect(found?.cfoAccepted).toBe(true);
      expect(found?.decisionHash).toMatch(/^[0-9a-f]{64}$/);
      const report = await getReport(hire.id);
      expect(report?.stage).toBe(2);
      expect(report?.pages?.[0].text).toContain("1.5%");
      await setHireStatus(hire.id, "delivered");
      expect((await getHire(hire.id))?.status).toBe("delivered");
      await poolB.end();
    } finally {
      await poolA.end();
      setLedgerForTests(new MemoryLedger());
    }
  });
});
