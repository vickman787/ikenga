import { publicActivity } from "@/lib/publicActivity";
import { NextResponse } from "next/server";
import { getLedger, listHires, summarizeHires } from "@/lib/jobs";
/** Public audit status and customer totals. Detailed decisions stay in private job APIs. */
export async function GET() {
  const ledger = await getLedger();
  const orders = await ledger.listOrders();
  let allOk = true;
  let onchainDecisions = 0;
  for (const order of orders) {
    if (!await ledger.verifyOrderChain(order.id)) allOk = false;
    onchainDecisions += (await ledger.listDecisions(order.id)).filter(decision => decision.txHash).length;
  }
  return NextResponse.json(publicActivity({
    verify: {ok: allOk},
    summary: summarizeHires(await listHires()),
    onchainDecisions,
  }), {headers:{"cache-control":"no-store"}});
}
