import { NextResponse } from "next/server";
import { getChainConfig, getHire, getLedger, readEscrowOnchain } from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/escrow — register the job's own JobEscrow contract.
 *
 * Body: { escrowAddress, txHash } — the escrow the customer's browser
 * deployed, and the transaction that deployed it.
 *
 * Nothing is taken on trust: the server reads the contract onchain and
 * checks the code exists, the escrow belongs to the wallet that placed
 * this job, it points at Ikenga's vault and token, and it is still
 * waiting for payment (UNFUNDED). Anything else is a plain-words 400.
 * On a match, the address is stored and the decision is logged.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { escrowAddress?: string; txHash?: string };
  if (!/^0x[0-9a-fA-F]{40}$/.test(body.escrowAddress ?? "")) {
    return NextResponse.json(
      { error: "That escrow address doesn't look right — it should start with 0x and be 42 characters." },
      { status: 400 },
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? "")) {
    return NextResponse.json(
      { error: "Send the transaction hash for the escrow deployment, so it can be checked onchain." },
      { status: 400 },
    );
  }
  const config = getChainConfig();
  // The escrow must match THIS job's payment — its token, its vault,
  // and the price fixed at hire time — not just the chain defaults. A
  // cNGN job's escrow holds cNGN in the cNGN vault at the fixed cNGN
  // price; a USDT job's holds USDT in the USDT vault at $1. Old jobs
  // (hired before currencies existed) fall back to the defaults.
  const jobToken = hire.tokenAddress || config.tokenAddress;
  const jobVault = hire.vaultAddress || config.vaultAddress;
  const jobPrice = BigInt(hire.priceAtomic);
  let onchain;
  try {
    onchain = await readEscrowOnchain(body.escrowAddress as `0x${string}`);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not check the escrow onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`,
      },
      { status: 502 },
    );
  }
  if (!onchain.exists) {
    return NextResponse.json(
      { error: "There's no contract at that address yet — the escrow may not be deployed." },
      { status: 400 },
    );
  }
  if (onchain.customer?.toLowerCase() !== hire.customerWallet.toLowerCase()) {
    return NextResponse.json(
      { error: "That escrow belongs to a different wallet — it has to be deployed for the wallet that placed this job." },
      { status: 400 },
    );
  }
  if (onchain.vault?.toLowerCase() !== jobVault.toLowerCase()) {
    return NextResponse.json(
      { error: "That escrow points at a different vault — it has to use Ikenga's vault." },
      { status: 400 },
    );
  }
  if (onchain.token?.toLowerCase() !== jobToken.toLowerCase()) {
    return NextResponse.json(
      { error: `That escrow uses a different token — it has to use ${hire.payCurrency}.` },
      { status: 400 },
    );
  }
  // New escrows report their price onchain; it must be exactly the
  // price fixed when the job was hired. Escrows deployed before the
  // cNGN change have no price() and report null — their price is the
  // old $1 constant, checked by the balance in the fund step instead.
  if (onchain.price != null && onchain.price !== jobPrice) {
    return NextResponse.json(
      { error: `That escrow holds a different price — this job costs ${hire.priceAtomic} atomic ${hire.payCurrency}.` },
      { status: 400 },
    );
  }
  if (onchain.state !== 0) {
    return NextResponse.json(
      { error: "That escrow isn't waiting for payment any more — it already has money in it, or it has finished." },
      { status: 400 },
    );
  }
  const ledger = await getLedger();
  await ledger.updateOrderEscrow(id, { escrowAddress: body.escrowAddress });
  await ledger.appendDecision({
    id: `dec_${id}_escrow_${Date.now()}`,
    orderId: id,
    kind: "escrow",
    reason: "Escrow deployed for this job.",
    amountMicroUsdc: hire.priceUsdc * 1_000_000,
    currency: hire.payCurrency,
    signature: "0xikenga-step2",
    txHash: body.txHash,
    entry: `escrow|${hire.payCurrency}|Escrow deployed.|${hire.priceAtomic}`,
  });
  return NextResponse.json({ job: await getHire(id) });
}
