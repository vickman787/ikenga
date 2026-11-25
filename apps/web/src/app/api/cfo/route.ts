import { publicActivity } from "@/lib/publicActivity";
import { NextResponse } from "next/server";
import { getLedger, ledgerBackend, listHires, summarizeHires } from "@/lib/jobs";

/** Public audit totals only. Job-specific decisions stay behind owner/worker access. */
export async function GET() {
  const ledger = await getLedger();
  const orders = await ledger.listOrders();
  const decisions: { orderId: string; kind: string; reason: string; amountMicroUsdc: number; prevHash: string; hash: string; txHash: string | null; createdAt: string }[] = [];
  let allOk = true;
  for (const order of orders) {
    const ok = await ledger.verifyOrderChain(order.id);
    if (!ok) allOk = false;
    for (const d of await ledger.listDecisions(order.id)) {
      decisions.push({
        orderId: d.orderId, kind: d.kind, reason: d.reason, amountMicroUsdc: d.amountMicroUsdc,
        prevHash: d.prevHash, hash: d.hash, txHash: d.txHash ?? null, createdAt: d.createdAt,
      });
    }
  }
  const hires = await listHires();
  const summary = summarizeHires(hires);
  return NextResponse.json(publicActivity({
    mode: ledgerBackend() === "postgres" ? "live" : "demo",
    backend: ledgerBackend(),
    verify: { ok: allOk, ordersChecked: orders.length, entries: decisions.length },
    jobs: summary.jobs,
    summary,
    decisions,
    note: "Decisions are hash-chained (sha256). Signatures are not yet real — the CFO signing key is a Step 3 item. The headline counts cover real jobs only: test runs we did while building are left out of the totals, but they stay in the signed log below.",
  }), { headers: { "cache-control": "no-store" } });
}
