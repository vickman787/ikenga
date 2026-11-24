import { NextResponse } from "next/server";
import { getChainConfig, getHire, getLedger, readEscrowOnchain, setHireStatus, startFreshRun, verifyTxReceipt } from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/fund — confirm the $1 has landed in the escrow.
 *
 * Body: { txHash } — the customer's fund() transaction.
 *
 * The server checks the receipt onchain (it must have succeeded), then
 * reads the escrow itself: it must be FUNDED and hold at least $1. Only
 * then does the job move to "escrowed" — and the team starts straight
 * away, with no tap needed: the same start the /run route does
 * (Investigator gate, Self check record, empty report, in-progress).
 * If the start cannot happen (a failed check, no AI key), the job
 * stays escrowed and the customer can still tap "Start the work" —
 * the button stays as the manual fallback. The fund itself is never
 * refused because the start failed: the $1 is in, and the response
 * says whether the team started (autoStarted) and why not if it did
 * not (autoStartError).
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
  // The escrow must hold the full price fixed when the job was hired —
  // $1 for a USDT job, the fixed cNGN amount for a cNGN job.
  const jobPrice = BigInt(hire.priceAtomic);
  const jobPriceLabel = hire.payCurrency === "cNGN" ? `${hire.priceAtomic} atomic cNGN` : "$1";
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
      { error: `The ${jobPriceLabel} hasn't landed in the escrow yet — the payment may still be on its way.` },
      { status: 400 },
    );
  }
  if (onchain.tokenBalance === null || onchain.tokenBalance < jobPrice) {
    return NextResponse.json(
      { error: `The escrow holds less than ${jobPriceLabel} — the full ${jobPriceLabel} has to be in before the team starts.` },
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
    reason: `Customer paid ${jobPriceLabel} into escrow.`,
    amountMicroUsdc: hire.priceUsdc * 1_000_000,
    currency: hire.payCurrency,
    signature: "0xikenga-step2",
    txHash: body.txHash,
    entry: `escrow|${hire.payCurrency}|Customer paid ${jobPriceLabel} into escrow.|${hire.priceAtomic}`,
  });
  // The $1 is in — start the team now, with no tap needed. A start
  // that cannot happen never fails the fund: the job stays escrowed
  // and "Start the work" is still there as the fallback.
  let autoStarted = false;
  let autoStartError: string | undefined;
  try {
    const started = await startFreshRun(id);
    autoStarted = started.ok;
    if (!started.ok) autoStartError = started.error;
  } catch (err) {
    autoStartError = err instanceof Error ? err.message : "unknown error";
  }
  return NextResponse.json({
    job: await getHire(id),
    autoStarted,
    ...(autoStartError ? { autoStartError } : {}),
  });
}
