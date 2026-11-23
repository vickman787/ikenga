import { NextResponse } from "next/server";
import { getBill, getBillEvents, verifyBillEvents } from "@/lib/bills";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bill = await getBill(id);
  if (!bill) return NextResponse.json({ error: "No bill with that id." }, { status: 404 });
  return NextResponse.json({
    bill,
    events: await getBillEvents(id),
    chainOk: await verifyBillEvents(id),
  });
}
