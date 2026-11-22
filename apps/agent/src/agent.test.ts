import { describe, expect, it } from "vitest";
import { decide, AgentRunner } from "./agent.js";
import { MemoryLedger } from "@ikenga/ledger";
import type { SelfVerificationResult } from "@ikenga/payments";

const AGENT_ADDRESS = "0x0000000000000000000000000000000000000001";

function verifiedSelf(): SelfVerificationResult {
  return {
    agentId: "123",
    agentAddress: AGENT_ADDRESS as `0x${string}`,
    verified: true,
    reason: "VERIFIED",
    checkedAt: new Date().toISOString(),
  };
}

function unverifiedSelf(): SelfVerificationResult {
  return {
    agentId: null,
    agentAddress: AGENT_ADDRESS as `0x${string}`,
    verified: false,
    reason: "NOT_REGISTERED",
    checkedAt: new Date().toISOString(),
  };
}

describe("decide()", () => {
  it("refuses when the Self Agent ID gate is unverified", () => {
    const d = decide({ jobType: "website", toolCostUsdc: 0.5, accepted: 0, quoted: 0, agentId: "123", selfVerified: false, selfReason: "NOT_REGISTERED" });
    expect(d.action).toBe("refuse");
    expect(d.selfVerified).toBe(false);
    expect(d.reason).toContain("Self Agent ID");
  });

  it("refuses a job the CFO declines, even when Self is verified", () => {
    const d = decide({ jobType: "promo-video", toolCostUsdc: 9, accepted: 0, quoted: 10, agentId: "123", selfVerified: true, selfReason: "VERIFIED" });
    expect(d.action).toBe("refuse");
    expect(d.quote.accepted).toBe(false);
  });

  it("proceeds only when the quote is accepted AND Self is verified", () => {
    const d = decide({ jobType: "website", toolCostUsdc: 0.5, accepted: 0, quoted: 0, agentId: "123", selfVerified: true, selfReason: "VERIFIED" });
    expect(d.action).toBe("proceed");
    expect(d.selfVerified).toBe(true);
  });
});

describe("AgentRunner.runJob()", () => {
  const base = {
    jobType: "market-report" as const,
    toolCostUsdc: 0.8,
    accepted: 0,
    quoted: 0,
    agentId: "123",
    agentAddress: AGENT_ADDRESS,
    orderId: "ord_run_1",
  };

  it("refuses an unverified agent and logs a self-refuse decision", async () => {
    const ledger = new MemoryLedger();
    const runner = new AgentRunner(ledger);
    const result = await runner.runJob(base, { verifySelf: async () => unverifiedSelf() });
    expect(result.decision.action).toBe("refuse");
    const decisions = await ledger.listDecisions(base.orderId);
    expect(decisions.some((d) => d.kind === "self-refuse")).toBe(true);
  });

  it("proceeds for a verified agent, refuses an unpinned tool payment, and records an FX refusal", async () => {
    const ledger = new MemoryLedger();
    const runner = new AgentRunner(ledger);
    const result = await runner.runJob(
      {
        ...base,
        orderId: "ord_run_2",
        toolCalls: [{ service: "market-data", payTo: "0x0000000000000000000000000000000000000002", amountAtomic: "10000", asset: "USDT" }],
        obligation: { naira: 500_000, minRate: 1500, deadline: "2026-12-07T09:00:00.000Z", supplierWallet: "0x0000000000000000000000000000000000000003" },
      },
      {
        verifySelf: async () => verifiedSelf(),
        getFxQuote: async () => ({ rate: 1400, expiresAt: "2026-11-21T11:00:00.000Z" }),
        now: "2026-11-21T10:00:00.000Z",
      },
    );
    expect(result.decision.action).toBe("proceed");
    // No sellers are registered, so the tool payment is refused, not paid.
    expect(result.toolPayments[0].status).toBe("refused");
    expect(result.fxDecision?.action).toBe("refuse");
    const decisions = await ledger.listDecisions("ord_run_2");
    expect(decisions.some((d) => d.kind === "fx-refuse")).toBe(true);
    expect(await ledger.verifyOrderChain("ord_run_2")).toBe(true);
  });

  it("attaches a market report from doWork and logs each agent step", async () => {
    const ledger = new MemoryLedger();
    const runner = new AgentRunner(ledger);
    const fakeReport = {
      report: "# Report\n\nPaystack charges 1.5%.",
      sources: [{ title: "Paystack", url: "https://example.com/paystack" }],
      steps: [
        { agent: "Scout" as const, what: "Found the sources.", detail: "", costUsd: 0 },
        { agent: "Writer" as const, what: "Wrote the report.", detail: "", model: "nvidia/nemotron-3.5-super-vl", tokens: 100, costUsd: 0.001 },
      ],
      totalTokens: 100,
      totalCostUsd: 0.001,
      status: "delivered" as const,
      revisions: 0,
    };
    const result = await runner.runJob(
      { ...base, orderId: "ord_run_4", description: "Compare payment options" },
      {
        verifySelf: async () => verifiedSelf(),
        doWork: async () => ({ deliverable: fakeReport.report, note: "Market report delivered.", report: fakeReport }),
      },
    );
    expect(result.decision.action).toBe("proceed");
    expect(result.report?.status).toBe("delivered");
    expect(result.report?.sources).toHaveLength(1);
    const decisions = await ledger.listDecisions("ord_run_4");
    expect(decisions.some((d) => d.reason.includes("Scout: Found the sources."))).toBe(true);
    expect(decisions.some((d) => d.reason.includes("Writer: Wrote the report."))).toBe(true);
    expect(await ledger.verifyOrderChain("ord_run_4")).toBe(true);
  });

  it("never retries an ambiguous tool payment", async () => {
    const ledger = new MemoryLedger();
    const runner = new AgentRunner(ledger);
    let calls = 0;
    runner.registerToolSeller("market-data", "0x0000000000000000000000000000000000000002", "100000", "USDT");
    const result = await runner.runJob(
      {
        ...base,
        orderId: "ord_run_3",
        toolCalls: [{ service: "market-data", payTo: "0x0000000000000000000000000000000000000002", amountAtomic: "10000", asset: "USDT" }],
      },
      {
        verifySelf: async () => verifiedSelf(),
        payTool: async () => {
          calls += 1;
          return { status: "ambiguous" as const, reason: "post-sign timeout — settlement may have completed" };
        },
      },
    );
    expect(calls).toBe(1);
    expect(result.toolPayments[0].status).toBe("ambiguous");
    const recon = await ledger.reconcile("ord_run_3");
    expect(recon.failed).toBe(1);
    expect(recon.settled).toBe(0);
  });
});
