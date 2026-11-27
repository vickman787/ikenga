import { NextResponse } from "next/server";
import { previewBill } from "@/lib/billQuote";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const amount = Number(new URL(req.url).searchParams.get("amountNgn"));
  try {
    return NextResponse.json(await previewBill(amount), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "A live quote is unavailable for this amount. Check the bill limits and try again shortly." }, { status: 503 });
  }
}
