import { NextResponse } from "next/server";
import { getLedger, ledgerBackend, listHires } from "@/lib/jobs";

/**
 * GET /api/cfo — the public, signed CFO decision log (modelled on Syncly's
 * /api/cfo). Every decision is hash-chained; `verify.ok` says whether the
 * chain recomputes cleanly. No signature is published: Step 2 decisions
 * carry a placeholder signature ("0xikenga-step2") until the CFO key signs
 * them for real — publishing it would imply a real signature.
 */
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
  return NextResponse.json({
    mode: ledgerBackend() === "postgres" ? "live" : "demo",
    backend: ledgerBackend(),
    verify: { ok: allOk, ordersChecked: orders.length, entries: decisions.length },
    jobs: listHires().length,
    decisions,
    note: "Decisions are hash-chained (sha256). Signatures are not yet real — the CFO signing key is a Step 3 item.",
  });
}
