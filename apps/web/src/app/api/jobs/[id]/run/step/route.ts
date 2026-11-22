import { NextResponse } from "next/server";
import { reportStageLabel, runReportStage } from "@ikenga/agent";
import {
  getHire,
  getLedger,
  getReport,
  progressToReport,
  reportToProgress,
  setHireStatus,
  setReport,
} from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/run/step — run ONE stage of the report.
 *
 * A whole report takes ~100s and the free plan cuts a request off at
 * 60s, so the run is split: Scout, then plan + write, then the numbers
 * check, then the read-through (and a second read-through if the first
 * one asked for fixes). Each stage is one short request that saves its
 * work and says which stage is next; the job page calls this route
 * until the report is delivered. Nothing here blocks for the whole
 * report.
 */
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = await getHire(id);
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
  const before = await getReport(id);
  if (!before) {
    return NextResponse.json(
      { error: "The work has not started yet — start it first." },
      { status: 400 },
    );
  }
  if (before.status !== "in-progress") {
    return NextResponse.json({ job: hire, report: before, nextStage: 0, done: true });
  }

  const stepsBefore = before.steps.length;
  const progress = await runReportStage(reportToProgress(before, hire.description), {});
  const stored = progressToReport(progress);
  await setReport(id, stored);

  const ledger = await getLedger();
  for (const step of stored.steps.slice(stepsBefore)) {
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
  if (progress.status === "delivered") {
    await setHireStatus(id, "delivered");
    await ledger.appendDecision({
      id: `dec_${id}_delivered_${Date.now()}`,
      orderId: id,
      kind: "quote",
      reason: `Market report delivered — ${stored.steps.length} steps, ${stored.sources.length} sources, about $${stored.totalCostUsd.toFixed(4)} of AI time.`,
      amountMicroUsdc: Math.round(stored.totalCostUsd * 1_000_000),
      signature: "0xikenga-step2",
      entry: `work|delivered|${stored.totalTokens}|${Math.round(stored.totalCostUsd * 1_000_000)}`,
    });
  } else if (progress.status === "refused") {
    // Back to draft, so the customer can try again with a clearer brief.
    await setHireStatus(id, "draft");
  }
  const job = await getHire(id);
  return NextResponse.json({
    job,
    report: stored,
    nextStage: stored.stage,
    nextStep: reportStageLabel(stored.stage),
    done: stored.stage === 0,
  });
}
