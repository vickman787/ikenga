import { NextResponse } from "next/server";
import { getLedger, isRealHire, ledgerBackend } from "@/lib/jobs";

/**
 * GET /api/traction — live numbers generated from the ledger, never
 * hand-typed. Every figure here is recomputed from stored orders,
 * decisions, x402 payments and FX swaps. The headline counts cover
 * real jobs only (see isRealHire): test runs we did while building are
 * left out of the totals. `decisions` is the one exception — it counts
 * every entry in the complete public log, test runs included, because
 * the log itself stays whole; the full log is in /api/cfo.
 */
export async function GET() {
  const ledger = await getLedger();
  const orders = await ledger.listOrders();
  const realOrders = orders.filter(isRealHire);
  const customers = new Set(realOrders.map((o) => o.customerWallet.toLowerCase()));
  let decisions = 0;
  let x402Settled = 0;
  let x402Unresolved = 0;
  let x402Failed = 0;
  let fxSwaps = 0;
  for (const order of orders) {
    decisions += (await ledger.listDecisions(order.id)).length;
  }
  for (const order of realOrders) {
    const recon = await ledger.reconcile(order.id);
    x402Settled += recon.settled;
    x402Unresolved += recon.unresolved;
    x402Failed += recon.failed;
    fxSwaps += (await ledger.listFxSwaps(order.id)).length;
  }
  return NextResponse.json({
    backend: ledgerBackend(),
    jobsStarted: realOrders.length,
    customers: customers.size,
    decisions,
    x402: { settled: x402Settled, unresolved: x402Unresolved, failed: x402Failed },
    fxSwaps,
    note: "Headline counts cover real jobs only — test runs we did while building are left out of the totals. The decision log itself stays complete: every decision, including test runs, is in /api/cfo.",
    generatedAt: new Date().toISOString(),
  });
}
