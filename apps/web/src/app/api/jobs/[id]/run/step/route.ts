import { randomUUID } from "node:crypto";
import { reservedStageCalls, StageBudgetError } from "@/lib/stageCalls";
import { requireJobAccess } from "@/lib/jobAccess";
import { NextResponse } from "next/server";
import { runCreativeStage, runReportStage, type CreativeJobType } from "@ikenga/agent";
import { JOB_LABELS } from "@ikenga/shared";
import {
  creativeToProgress,
  deliveryStageLabel,
  getHire,
  getLedger,
  getReport,
  progressToCreative,
  progressToReport,
  reportToProgress,
  setHireStatus,
  setReport,
} from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/run/step — run ONE stage of the job.
 *
 * A whole job takes ~100s and the free plan cuts a request off at
 * 60s, so the run is split: read the brief (or search the market),
 * then build it, then check it, then the read-through in two short
 * parts (and a second read-through if the first one asked for fixes).
 * Each stage is one short request that saves its work and says which
 * stage is next; the job page calls this route until the work is
 * delivered. Nothing here blocks for the whole job.
 */
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denial = await requireJobAccess(req, id);
  if (denial) return denial;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  if (!process.env.OPENAI_API_KEY) {
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

  if (hire.status !== "in-progress") return NextResponse.json({error:"This job is no longer running."},{status:409});
  const ledger = await getLedger();
  const token=randomUUID();
  const upgraded=before.generatorVersion===2;
  const claimed=upgraded?await ledger.claimReportStage(id,before.stage,token):before;
  if(!claimed)return NextResponse.json({busy:true,done:false,retryAfterMs:2000},{status:202,headers:{'retry-after':'2'}});
  const stepsBefore = claimed.steps.length;
  const isReport = hire.jobType === "market-report";
  const deps=upgraded?reservedStageCalls(ledger,id,token):{};
  let stored;
  try {
    stored=isReport
      ? progressToReport(await runReportStage(reportToProgress(claimed,hire.description),deps))
      : progressToCreative(await runCreativeStage(creativeToProgress(claimed,hire.description,hire.jobType as CreativeJobType),deps));
  }catch(error){
    if(upgraded&&error instanceof StageBudgetError){
      const failed={...claimed,status:"refused" as const,stage:0,reason:error.message};
      const saved=await ledger.completeReportStage(id,token,failed);
      if(saved)return NextResponse.json({job:await getHire(id),report:saved,nextStage:0,done:true});
    }
    if(upgraded)await ledger.abandonReportStage(id,token);
    return NextResponse.json({error:"This step was interrupted. Its spending allowance has been retained; you can retry within the remaining job budget."},{status:502});
  }
  if(upgraded){
    const saved=await ledger.completeReportStage(id,token,stored);
    if(!saved)return NextResponse.json({error:"The job changed while this step was running. No delivery was recorded."},{status:409});
    stored=saved;
  }else{
    const current=await getHire(id);
    if(current?.status!=="in-progress")return NextResponse.json({error:"This job is no longer running."},{status:409});
    await setReport(id,stored);
  }
  for (const step of stored.steps.slice(stepsBefore)) {
    await ledger.appendDecision({
      id: `dec_${id}_${step.agent}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      orderId: id,
      kind: "quote",
      reason: `${step.agent}: ${step.what}${step.costUsd !== undefined ? ` (about $${step.costUsd.toFixed(4)} of AI time)` : ""}`,
      amountMicroUsdc: Math.round((step.costUsd ?? 0) * 1_000_000),
      signature: "0xikenga-step2",
      // The step's detail rides in the entry too, so Messenger's
      // delivery receipt (with the deliverable's fingerprint) is in
      // the signed log, not only on the job page.
      entry: `work|${step.agent}|${step.what}|${step.detail ? `${step.detail}|` : ""}${Math.round((step.costUsd ?? 0) * 1_000_000)}`,
    });
  }
  if (stored.status === "delivered") {
    if(!upgraded)await setHireStatus(id, "delivered");
    const deliveredDetail =
      isReport
        ? `${stored.steps.length} steps, ${stored.sources.length} sources`
        : `${stored.steps.length} steps`;
    await ledger.appendDecision({
      id: `dec_${id}_delivered_${Date.now()}`,
      orderId: id,
      kind: "quote",
      reason: `${JOB_LABELS[hire.jobType]} delivered — ${deliveredDetail}, about $${stored.totalCostUsd.toFixed(4)} of AI time.`,
      amountMicroUsdc: Math.round(stored.totalCostUsd * 1_000_000),
      signature: "0xikenga-step2",
      entry: `work|delivered|${stored.totalTokens}|${Math.round(stored.totalCostUsd * 1_000_000)}`,
    });
  } else if (stored.status === "refused") {
    // A failed quality check does not erase an already funded escrow.
    if(!upgraded)await setHireStatus(id, "draft");
  }
  const job = await getHire(id);
  return NextResponse.json({
    job,
    report: stored,
    nextStage: stored.stage,
    nextStep: deliveryStageLabel(hire.jobType, stored.stage),
    done: stored.stage === 0,
  });
}
