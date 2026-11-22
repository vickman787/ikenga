import { NextResponse } from "next/server";
import { getHire, getLedger, setHireStatus } from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/decision — accept, or turn the work down.
 *
 * Body: { action: "accept" | "reject" }.
 * Accept means the customer is happy with the work. Reject means they get
 * their money back, plus the bond the CFO put up — recorded in the log.
 * No money moves here yet (the escrow is not switched on), so this is a
 * recorded decision, not a payment.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "accept" && body.action !== "reject") {
    return NextResponse.json({ error: "Tell us accept or reject." }, { status: 400 });
  }
  const ledger = await getLedger();
  if (body.action === "accept") {
    setHireStatus(id, "accepted");
    await ledger.appendDecision({
      id: `dec_${id}_accept_${Date.now()}`,
      orderId: id,
      kind: "accept",
      reason: "Customer accepted the work.",
      amountMicroUsdc: hire.priceUsdc * 1_000_000,
      signature: "0xikenga-step2",
      entry: `accept|Customer accepted the work.|${hire.priceUsdc * 1_000_000}`,
    });
  } else {
    setHireStatus(id, "refunded");
    await ledger.appendDecision({
      id: `dec_${id}_reject_${Date.now()}`,
      orderId: id,
      kind: "reject",
      reason: `Customer turned the work down — refund of $${hire.priceUsdc} plus the $${hire.bondUsdc} bond.`,
      amountMicroUsdc: hire.priceUsdc * 1_000_000,
      signature: "0xikenga-step2",
      entry: `reject|Customer turned the work down.|${hire.priceUsdc * 1_000_000}`,
    });
  }
  return NextResponse.json({ job: getHire(id) });
}
