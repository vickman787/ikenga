import { NextResponse } from "next/server";
import { getHire, getLedger, getReport } from "@/lib/jobs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = getHire(id);
  if (!hire) return NextResponse.json({ error: "job not found" }, { status: 404 });
  const ledger = await getLedger();
  const order = await ledger.getOrder(id);
  const decisions = await ledger.listDecisions(id);
  const chainOk = await ledger.verifyOrderChain(id);
  const fxSwaps = await ledger.listFxSwaps(id);
  const reconciliation = await ledger.reconcile(id);
  return NextResponse.json({
    job: hire,
    report: getReport(id),
    order,
    decisions: decisions.map((d) => ({
      id: d.id, kind: d.kind, reason: d.reason, amountMicroUsdc: d.amountMicroUsdc,
      prevHash: d.prevHash, hash: d.hash, txHash: d.txHash ?? null, createdAt: d.createdAt,
    })),
    verify: { ok: chainOk },
    fxSwaps,
    reconciliation,
  });
}
