import { NextResponse } from "next/server";
import { getChainConfig, getHire, getLedger, readEscrowOnchain, setHireStatus, verifyTxReceipt } from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/fund — confirm the $1 has landed in the escrow.
 *
 * Body: { txHash } — the customer's fund() transaction.
 *
 * The server checks the receipt onchain (it must have succeeded), then
 * reads the escrow itself: it must be FUNDED and hold at least $1. Only
 * then does the job move to "escrowed" — the state the team needs before
 * it starts. Anything else is a plain-words 400.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? "")) {
    return NextResponse.json(
      { error: "Send the transaction hash for the $1 payment, so it can be checked onchain." },
      { status: 400 },
    );
  }
  if (!hire.escrowAddress) {
    return NextResponse.json(
      { error: "There's no escrow for this job yet — deploy it first, then pay the $1 in." },
      { status: 400 },
    );
  }
  const config = getChainConfig();
  let receipt;
  try {
    receipt = await verifyTxReceipt(body.txHash as `0x${string}`);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not check the payment onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`,
      },
      { status: 502 },
    );
  }
  if (!receipt.ok) {
    return NextResponse.json(
      { error: "That payment didn't go through onchain — check the transaction hash and try again." },
      { status: 400 },
    );
  }
  let onchain;
  try {
    onchain = await readEscrowOnchain(hire.escrowAddress as `0x${string}`);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not check the escrow onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`,
      },
      { status: 502 },
    );
  }
  if (onchain.state !== 1) {
    return NextResponse.json(
      { error: "The $1 hasn't landed in the escrow yet — the payment may still be on its way." },
      { status: 400 },
    );
  }
  if (onchain.tokenBalance === null || onchain.tokenBalance < BigInt(config.priceAtomic)) {
    return NextResponse.json(
      { error: "The escrow holds less than $1 — the full $1 has to be in before the team starts." },
      { status: 400 },
    );
  }
  const ledger = await getLedger();
  await ledger.updateOrderEscrow(id, { fundTxHash: body.txHash });
  await setHireStatus(id, "escrowed");
  await ledger.appendDecision({
    id: `dec_${id}_fund_${Date.now()}`,
    orderId: id,
    kind: "escrow",
    reason: "Customer paid $1 into escrow.",
    amountMicroUsdc: hire.priceUsdc * 1_000_000,
    signature: "0xikenga-step2",
    txHash: body.txHash,
    entry: `escrow|Customer paid $1 into escrow.|${hire.priceUsdc * 1_000_000}`,
  });
  return NextResponse.json({ job: await getHire(id) });
}
