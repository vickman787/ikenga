import { NextResponse } from "next/server";
import { getLedger, isRealHire } from "@/lib/jobs";
import { publicTraction } from "@/lib/publicActivity";
/** Public customer totals only; operational diagnostics are not published. */
export async function GET() {
  const realOrders = (await (await getLedger()).listOrders()).filter(isRealHire);
  return NextResponse.json(publicTraction({
    jobsStarted: realOrders.length,
    customers: new Set(realOrders.map(order => order.customerWallet.toLowerCase())).size,
  }), { headers: { "cache-control": "no-store" } });
}
