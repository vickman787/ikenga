import { NextResponse } from "next/server";
import { BillInputSchema, createBill, listBills } from "@/lib/bills";
import { getChainConfig, ledgerBackend } from "@/lib/jobs";

import { previewBill } from "@/lib/billQuote";

export async function GET() {
  const bills = await listBills();
  return NextResponse.json({
    bills: [...bills].reverse(),
    backend: ledgerBackend(),
    note: "A naira bill is one person owing a supplier in naira. Ikenga changes USDT to cNGN and pays the supplier — according to the payer’s minimum rate and chosen deadline rule. Nothing moves until the agent wallet holds the USDT for it.",
  });
}

export async function POST(req: Request) {
  // Bills run on Celo mainnet only — there is no Celo testnet corridor.
  if (getChainConfig().chainId !== 42220) {
    return NextResponse.json(
      { error: "Naira bills run on Celo mainnet only — there is no testnet corridor." },
      { status: 400 },
    );
  }
  try {
    const body = BillInputSchema.parse(await req.json());
    if (body.rateMode === "current" || body.payNow === true) {
      const live = await previewBill(body.amountNgn);
      if (live.rate < body.minRate) {
        return NextResponse.json({ error: "The live rate changed. Refresh the quote and review the updated rate limit." }, { status: 409 });
      }
    }
    const bill = await createBill(body);
    return NextResponse.json({ bill }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
