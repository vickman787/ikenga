import { requireJobAccess } from "@/lib/jobAccess";
import { NextResponse } from "next/server";
import { creativeRevisionProgress, revisionProgress, type CreativeJobType } from "@ikenga/agent";
import {
  creativeToProgress,
  deliveryStageLabel,
  getHire,
  getReport,
  progressToCreative,
  progressToReport,
  reportToProgress,
  setHireStatus,
  setReport,
  startFreshRun,
} from "@/lib/jobs";

/**
 * The free hosting plan cuts a request off at 60s, so this route never
 * does the work itself — it only starts it. A whole job takes ~100s,
 * so the work runs in short stages (see /run/step): this route sets the
 * job going and answers straight away (202) with the next stage, and
 * the job page calls the step route until the work is delivered.
 *
 * POST /api/jobs/[id]/run — start the work, or ask for a revision.
 *
 * The /fund route calls the same start as soon as the $1 is confirmed
 * in the escrow, so a funded job usually starts on its own — this
 * route is the manual fallback (the "Start the work" button) and the
 * resume path when a start could not happen at fund time.
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
 * it is still pending, the page says so. The AI key (OPENAI_API_KEY)
 * is a server env var; without it this route says plainly that the AI
 * is not connected yet.
 *
 * Body: { revisionNote?: string } — ask for one free revision of
 * delivered work (reuses the sources or facts already gathered).
 */
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denial = await requireJobAccess(req, id);
  if (denial) return denial;
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

  if (revisionNote && ["accepted", "refunded", "rejected"].includes(hire.status)) return NextResponse.json({error:"This job is settled. Its delivered work and receipt are preserved."},{status:409});

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
  // and never hit this gate. The /fund route calls the same start, so
  // a funded job usually starts on its own — this route is the manual
  // fallback (the "Start the work" button) and the resume path.
  const started = await startFreshRun(id);
  if (!started.ok) {
    return NextResponse.json({ error: started.error }, { status: started.status });
  }
  return NextResponse.json(
    { job: started.job, report: started.report, nextStage: started.nextStage, nextStep: started.nextStep, done: false },
    { status: 202 },
  );
}
