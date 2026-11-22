import { NextResponse } from "next/server";
import { getLedger, ledgerBackend } from "@/lib/jobs";

/**
 * GET /api/traction — live numbers generated from the ledger, never
 * hand-typed. Every figure here is recomputed from stored orders,
 * decisions, x402 payments and FX swaps.
 */
export async function GET() {
  const ledger = await getLedger();
  const orders = await ledger.listOrders();
  const customers = new Set(orders.map((o) => o.customerWallet.toLowerCase()));
  let decisions = 0;
  let x402Settled = 0;
  let x402Unresolved = 0;
  let x402Failed = 0;
  let fxSwaps = 0;
  for (const order of orders) {
    decisions += (await ledger.listDecisions(order.id)).length;
    const recon = await ledger.reconcile(order.id);
    x402Settled += recon.settled;
    x402Unresolved += recon.unresolved;
    x402Failed += recon.failed;
    fxSwaps += (await ledger.listFxSwaps(order.id)).length;
  }
  return NextResponse.json({
    backend: ledgerBackend(),
    jobsStarted: orders.length,
    customers: customers.size,
    decisions,
    x402: { settled: x402Settled, unresolved: x402Unresolved, failed: x402Failed },
    fxSwaps,
    generatedAt: new Date().toISOString(),
  });
}
