import { NextResponse } from "next/server";
import { reportStageLabel, revisionProgress } from "@ikenga/agent";
import {
  emptyStoredReport,
  getHire,
  getLedger,
  getReport,
  progressToReport,
  reportToProgress,
  setHireStatus,
  setReport,
} from "@/lib/jobs";
import { verifySelfAgentId } from "@ikenga/payments";

/**
 * The free hosting plan cuts a request off at 60s, so this route never
 * does the work itself — it only starts it. A whole report takes ~100s,
 * so the work runs in short stages (see /run/step): this route sets the
 * job going and answers straight away (202) with the next stage, and
 * the job page calls the step route until the report is delivered.
 *
 * POST /api/jobs/[id]/run — start the work, or ask for a revision.
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
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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
  const body = (await req.json().catch(() => ({}))) as { revisionNote?: string };
  const revisionNote = typeof body.revisionNote === "string" ? body.revisionNote.slice(0, 500) : undefined;
  const existing = await getReport(id);

  // Already running: say where it is, so the page can pick up the stages.
  if (existing && existing.status === "in-progress") {
    return NextResponse.json(
      { job: hire, report: existing, nextStage: existing.stage, nextStep: reportStageLabel(existing.stage), done: false },
      { status: 202 },
    );
  }

  // A delivered report with a note: a revision, back to the writing
  // stage, reusing the pages Scout already read.
  if (existing && existing.status === "delivered" && revisionNote) {
    const stored = progressToReport(revisionProgress(reportToProgress(existing, hire.description), revisionNote));
    await setReport(id, stored);
    await setHireStatus(id, "in-progress");
    const job = await getHire(id);
    return NextResponse.json(
      { job, report: stored, nextStage: stored.stage, nextStep: reportStageLabel(stored.stage), done: false },
      { status: 202 },
    );
  }

  // Delivered and no note: there is nothing to start.
  if (existing && existing.status === "delivered") {
    return NextResponse.json({ job: hire, report: existing, nextStage: 0, done: true }, { status: 200 });
  }

  // Fresh start (or trying again after the team could not finish it).
  // Record the Self check honestly — it governs payment, and no money
  // moves on this job yet, so an unverified agent can still write.
  const ledger = await getLedger();
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

  await setHireStatus(id, "in-progress");
  const stored = emptyStoredReport();
  await setReport(id, stored);
  const job = await getHire(id);
  return NextResponse.json(
    { job, report: stored, nextStage: stored.stage, nextStep: reportStageLabel(stored.stage), done: false },
    { status: 202 },
  );
}
