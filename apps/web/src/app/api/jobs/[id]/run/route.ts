import { NextResponse } from "next/server";
import { creativeRevisionProgress, revisionProgress, type CreativeJobType } from "@ikenga/agent";
import {
  creativeToProgress,
  deliveryStageLabel,
  emptyStoredCreative,
  emptyStoredReport,
  getHire,
  getLedger,
  getReport,
  investigateHireEscrow,
  progressToCreative,
  progressToReport,
  reportToProgress,
  setHireStatus,
  setReport,
} from "@/lib/jobs";
import { verifySelfAgentId } from "@ikenga/payments";

/**
 * The free hosting plan cuts a request off at 60s, so this route never
 * does the work itself — it only starts it. A whole job takes ~100s,
 * so the work runs in short stages (see /run/step): this route sets the
 * job going and answers straight away (202) with the next stage, and
 * the job page calls the step route until the work is delivered.
 *
 * POST /api/jobs/[id]/run — start the work, or ask for a revision.
 *
 * All four job types run here now: the market report (Scout searches
 * the web, Reader reads the pages, Writer writes, Analyst checks, a
 * different model reads it, Messenger delivers it), the website and
 * the flyers (Designer reads the brief and builds the page, Analyst
 * checks every word and price against the brief, a different model
 * reads it), and the promo video (Producer puts a motion slideshow
 * together from the brief — moving slides, not a video file). Every
 * step and its AI cost go in the money log. Before the team starts,
 * Investigator checks the job's escrow onchain — a failed check stops
 * the job in plain words and nothing is spent.
 *
 * No money moves in this route itself — the $1 is already in the
 * job's escrow before this route will start anything (see the fresh-start
 * gate below), and accepting or turning the work down moves it onchain
 * from the job page. The agent's Self check is recorded honestly — when
 * it is still pending, the page says so. The AI key (FORTYTWO_API_KEY)
 * is a server env var; without it this route says plainly that the AI
 * is not connected yet.
 *
 * Body: { revisionNote?: string } — ask for one free revision of
 * delivered work (reuses the sources or facts already gathered).
 */
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { revisionNote?: string };
  const revisionNote = typeof body.revisionNote === "string" ? body.revisionNote.slice(0, 500) : undefined;
  const existing = await getReport(id);
  const isReport = hire.jobType === "market-report";

  // Already running: say where it is, so the page can pick up the stages.
  if (existing && existing.status === "in-progress") {
    return NextResponse.json(
      { job: hire, report: existing, nextStage: existing.stage, nextStep: deliveryStageLabel(hire.jobType, existing.stage), done: false },
      { status: 202 },
    );
  }

  // Delivered work with a note: a revision, back to the writing stage,
  // reusing the pages Scout already read (or the facts already read).
  if (existing && existing.status === "delivered" && revisionNote) {
    const stored = isReport
      ? progressToReport(revisionProgress(reportToProgress(existing, hire.description), revisionNote))
      : progressToCreative(
          creativeRevisionProgress(creativeToProgress(existing, hire.description, hire.jobType as CreativeJobType), revisionNote),
        );
    await setReport(id, stored);
    await setHireStatus(id, "in-progress");
    const job = await getHire(id);
    return NextResponse.json(
      { job, report: stored, nextStage: stored.stage, nextStep: deliveryStageLabel(hire.jobType, stored.stage), done: false },
      { status: 202 },
    );
  }

  // Delivered and no note: there is nothing to start.
  if (existing && existing.status === "delivered") {
    return NextResponse.json({ job: hire, report: existing, nextStage: 0, done: true }, { status: 200 });
  }

  // Fresh start (or trying again after the team could not finish it).
  // The team only starts once the $1 is in the job's escrow — a draft
  // with no funded escrow is turned away in plain words. Resuming work
  // already in progress, and revising delivered work, are handled above
  // and never hit this gate.
  if (hire.status !== "escrowed") {
    return NextResponse.json(
      { error: "Pay the $1 into escrow first — the team starts once the money is in." },
      { status: 400 },
    );
  }
  if (!process.env.FORTYTWO_API_KEY) {
    return NextResponse.json(
      { error: "The AI is not connected yet — the team cannot start the work until its key is set on the server." },
      { status: 503 },
    );
  }
  // Investigator checks the escrow onchain before the team starts:
  // it must be a real contract, and its customer, token, vault, price
  // and funded state must match this job. Every check is written to
  // the log. A failed check stops the job in plain words — the $1
  // stays in escrow and nothing is spent. An unreadable chain waits —
  // the job stays escrowed, so the customer can start it again.
  const ledger = await getLedger();
  const investigation = await investigateHireEscrow(hire);
  // Writing the checks to the log must not fail silently into an empty
  // 500: when the log cannot take them, say so in plain words and do
  // not start the job without its audit trail. (This caught a real
  // bug: the decision_log CHECK list did not allow 'investigate'.)
  try {
    for (let i = 0; i < investigation.checks.length; i++) {
      const check = investigation.checks[i];
      await ledger.appendDecision({
        id: `dec_${id}_investigate_${i}_${Date.now()}`,
        orderId: id,
        kind: "investigate",
        reason: `Investigator: ${check.detail}`,
        amountMicroUsdc: 0,
        signature: "0xikenga-step2",
        entry: `investigate|job|${check.name}|${check.result}|${check.detail}`,
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: `The checks could not be written to the money log — try starting the work again in a moment. (${err instanceof Error ? err.message : "unknown error"})` },
      { status: 502 },
    );
  }
  if (!investigation.readable) {
    return NextResponse.json(
      { error: "Investigator could not read the escrow onchain right now — try starting the work again in a moment." },
      { status: 502 },
    );
  }
  if (!investigation.passed) {
    return NextResponse.json({ error: investigation.summary }, { status: 400 });
  }
  // Record the Self check honestly — it governs payment, and the $1 is
  // held in escrow for this job.
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
        : `Agent identity not verified yet (${self.reason}) — the $1 stays in escrow.`,
      amountMicroUsdc: 0,
      signature: "0xikenga-step2",
      entry: `self|${self.verified}|${self.reason}|0`,
    });
  } catch (err) {
    // A failed identity check never stops the work — it is logged.
    await ledger.appendDecision({
      id: `dec_${id}_self_${Date.now()}`,
      orderId: id,
      kind: "self-refuse",
      reason: `Agent identity check could not run (${err instanceof Error ? err.message : "unknown error"}) — the $1 stays in escrow.`,
      amountMicroUsdc: 0,
      signature: "0xikenga-step2",
      entry: `self|check-failed|0`,
    });
  }

  await setHireStatus(id, "in-progress");
  const stored = isReport ? emptyStoredReport() : emptyStoredCreative(hire.jobType);
  await setReport(id, stored);
  const job = await getHire(id);
  return NextResponse.json(
    { job, report: stored, nextStage: stored.stage, nextStep: deliveryStageLabel(hire.jobType, stored.stage), done: false },
    { status: 202 },
  );
}
