import { NextResponse } from "next/server";
import { getHire, getLedger, setHireStatus, setReport } from "@/lib/jobs";
import { runMarketReport } from "@ikenga/agent";
import { verifySelfAgentId } from "@ikenga/payments";

/** A report run takes ~100s — ask for the longest window Vercel allows. */
export const maxDuration = 300;

/**
 * POST /api/jobs/[id]/run — the team does the work.
 *
 * Market-report jobs only (the one job type with a real delivery so far).
 * The team searches the web, writes the report on FortyTwo, checks the
 * numbers, and a different model reads it before it reaches you. Every
 * step and its AI cost go in the money log.
 *
 * No money moves here: the escrow is not switched on yet, and the agent's
 * Self check is recorded honestly — when it is still pending, the page
 * says so. The AI key (FORTYTWO_API_KEY) is a server env var; without it
 * this route says plainly that the AI is not connected yet.
 *
 * Body: { revisionNote?: string } — ask for one free revision of a
 * delivered report (reuses the sources already gathered).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (hire.jobType !== "market-report") {
    return NextResponse.json(
      { error: "Only the market report can be done by the team right now — the other jobs are not wired up yet." },
      { status: 400 },
    );
  }
  if (!process.env.FORTYTWO_API_KEY) {
    return NextResponse.json(
      { error: "The AI is not connected yet — the team cannot start the work until its key is set on the server." },
      { status: 503 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { revisionNote?: string };
  const revisionNote = typeof body.revisionNote === "string" ? body.revisionNote.slice(0, 500) : undefined;

  try {
    setHireStatus(id, "in-progress");
    const ledger = await getLedger();

    // Record the Self check honestly — it governs payment, and no money
    // moves on this job yet, so an unverified agent can still write.
    try {
      const agentAddress = (process.env.SELF_AGENT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
      const self = await verifySelfAgentId(agentAddress, process.env.SELF_AGENT_ID);
      await ledger.recordSelfVerification({
        id: `self_${id}_${Date.now()}`,
        agentId: self.agentId,
        agentAddress: self.agentAddress,
        verified: self.verified,
        reason: self.reason,
        expiresAt: self.expiresAt ?? null,
        checkedAt: self.checkedAt,
      });
      await ledger.appendDecision({
        id: `dec_${id}_self_${Date.now()}`,
        orderId: id,
        kind: self.verified ? "self-verify" : "self-refuse",
        reason: self.verified
          ? "Agent identity verified — the team can be paid for this job."
          : `Agent identity not verified yet (${self.reason}) — the team can write the report, but no money moves on this job.`,
        amountMicroUsdc: 0,
        signature: "0xikenga-step2",
        entry: `self|${self.verified}|${self.reason}|0`,
      });
    } catch (err) {
      // A failed identity check never stops the writing — it is logged.
      await ledger.appendDecision({
        id: `dec_${id}_self_${Date.now()}`,
        orderId: id,
        kind: "self-refuse",
        reason: `Agent identity check could not run (${err instanceof Error ? err.message : "unknown error"}) — the team can write the report, but no money moves on this job.`,
        amountMicroUsdc: 0,
        signature: "0xikenga-step2",
        entry: `self|check-failed|0`,
      });
    }

    const result = await runMarketReport({ brief: hire.description }, { revisionNote });
    const stored = {
      report: result.report,
      sources: result.sources,
      steps: result.steps,
      totalTokens: result.totalTokens,
      totalCostUsd: result.totalCostUsd,
      status: result.status,
      reason: result.reason,
      revisions: result.revisions,
      deliveredAt: new Date().toISOString(),
    };
    setReport(id, stored);
    for (const step of result.steps) {
      await ledger.appendDecision({
        id: `dec_${id}_${step.agent}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        orderId: id,
        kind: "quote",
        reason: `${step.agent}: ${step.what}${step.costUsd !== undefined ? ` (about $${step.costUsd.toFixed(4)} of AI time)` : ""}`,
        amountMicroUsdc: Math.round((step.costUsd ?? 0) * 1_000_000),
        signature: "0xikenga-step2",
        entry: `work|${step.agent}|${step.what}|${Math.round((step.costUsd ?? 0) * 1_000_000)}`,
      });
    }
    if (result.status === "delivered") {
      setHireStatus(id, "delivered");
      await ledger.appendDecision({
        id: `dec_${id}_delivered_${Date.now()}`,
        orderId: id,
        kind: "quote",
        reason: `Market report delivered — ${result.steps.length} steps, ${result.sources.length} sources, about $${result.totalCostUsd.toFixed(4)} of AI time.`,
        amountMicroUsdc: Math.round(result.totalCostUsd * 1_000_000),
        signature: "0xikenga-step2",
        entry: `work|delivered|${result.totalTokens}|${Math.round(result.totalCostUsd * 1_000_000)}`,
      });
    }
    return NextResponse.json({ job: getHire(id), report: stored });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The team could not finish the report — try again." },
      { status: 500 },
    );
  }
}
