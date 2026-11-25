import { requireJobAccess } from "@/lib/jobAccess";
import { NextResponse } from "next/server";
import { deliveryStageLabel } from "@/lib/jobs";
import { getHire, getLedger, getReport, ledgerBackend } from "@/lib/jobs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denial = await requireJobAccess(req, id);
  if (denial) return denial;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const ledger = await getLedger();
  const order = await ledger.getOrder(id);
  const decisions = await ledger.listDecisions(id);
  const chainOk = await ledger.verifyOrderChain(id);
  const fxSwaps = await ledger.listFxSwaps(id);
  const reconciliation = await ledger.reconcile(id);
  const report = await getReport(id);
  return NextResponse.json({
    job: hire,
    report,
    // Plain-words label for what the team is doing right now, if anything.
    nextStep: report && report.status === "in-progress" ? deliveryStageLabel(hire.jobType, report.stage) : null,
    backend: ledgerBackend(),
    order,
    decisions: decisions.map((d) => ({
      id: d.id, kind: d.kind, reason: d.reason, amountMicroUsdc: d.amountMicroUsdc,
      prevHash: d.prevHash, hash: d.hash, txHash: d.txHash ?? null, createdAt: d.createdAt,
    })),
    verify: { ok: chainOk },
    fxSwaps,
    reconciliation,
  }, { headers: { "cache-control": "private, no-store", "vary": "Cookie" } });
}
