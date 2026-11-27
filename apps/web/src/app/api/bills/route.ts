import { NextResponse } from "next/server";
import { createBill, listBills } from "@/lib/bills";
import { getChainConfig, ledgerBackend } from "@/lib/jobs";

export async function GET() {
  const bills = await listBills();
  return NextResponse.json({
    bills: [...bills].reverse(),
    backend: ledgerBackend(),
    note: "A naira bill is one person owing a supplier in naira. Ikenga changes USDT to cNGN and pays the supplier — only at the rate the payer named, at the current rate when they chose pay-now, or at the deadline. Nothing moves until the agent wallet holds the USDT for it.",
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
    const body = await req.json();
    const bill = await createBill(body);
    return NextResponse.json({ bill }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
