import { requireJobAccess } from "@/lib/jobAccess";
import { NextResponse } from "next/server";
import { getHire, getLedger, readEscrowOnchain, setHireStatus, verifyTxReceipt } from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/decision — accept the work, or turn it down.
 *
 * Body: { action: "accept" | "reject", txHash }.
 * Accept means the customer is happy with the work: the $1 in escrow
 * goes to the team. Reject means they get the $1 back. The bond is 0,
 * so no bond moves either way.
 *
 * The transaction hash is required — there is no decision without the
 * money moving. The server checks it onchain first: the receipt must
 * have succeeded, the transaction must have come from the wallet that
 * placed this job and called this job's escrow, and the escrow must be
 * in the matching state (ACCEPTED for accept, REJECTED for reject).
 * Only then is the decision recorded, with the tx hash in the log.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denial = await requireJobAccess(req, id);
  if (denial) return denial;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; txHash?: string };
  if (body.action !== "accept" && body.action !== "reject") {
    return NextResponse.json({ error: "Tell us accept or reject." }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? "")) {
    return NextResponse.json(
      { error: "Send the transaction hash for the accept or reject payment — the decision only counts once the money has moved onchain." },
      { status: 400 },
    );
  }
  if (!hire.escrowAddress) {
    return NextResponse.json(
      { error: "There's no escrow for this job yet, so there's no payment to accept or turn down." },
      { status: 400 },
    );
  }
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
  if (receipt.to?.toLowerCase() !== hire.escrowAddress.toLowerCase()) {
    return NextResponse.json(
      { error: "That payment didn't call this job's escrow — check the transaction hash and try again." },
      { status: 400 },
    );
  }
  if (receipt.from?.toLowerCase() !== hire.customerWallet.toLowerCase()) {
    return NextResponse.json(
      { error: "That payment didn't come from the wallet that placed this job — only that wallet can accept or turn the work down." },
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
  const wantedState = body.action === "accept" ? 2 : 3;
  if (onchain.state !== wantedState) {
    return NextResponse.json(
      {
        error:
          body.action === "accept"
            ? "The work hasn't been accepted onchain yet — the accept payment has to go through first."
            : "The work hasn't been turned down onchain yet — the reject payment has to go through first.",
      },
      { status: 400 },
    );
  }
  const ledger = await getLedger();
  await ledger.updateOrderEscrow(id, { settleTxHash: body.txHash });
  const priceLabel = hire.payCurrency === "cNGN" ? `${hire.priceAtomic} atomic cNGN` : "$1";
  if (body.action === "accept") {
    await setHireStatus(id, "accepted");
    await ledger.appendDecision({
      id: `dec_${id}_accept_${Date.now()}`,
      orderId: id,
      kind: "accept",
      reason: `Customer accepted the work — the ${priceLabel} in escrow goes to the team.`,
      amountMicroUsdc: hire.priceUsdc * 1_000_000,
      currency: hire.payCurrency,
      signature: "0xikenga-step2",
      txHash: body.txHash,
      entry: `accept|${hire.payCurrency}|Customer accepted the work.|${hire.priceAtomic}`,
    });
  } else {
    await setHireStatus(id, "refunded");
    await ledger.appendDecision({
      id: `dec_${id}_reject_${Date.now()}`,
      orderId: id,
      kind: "reject",
      reason: `Customer turned the work down — the ${priceLabel} in escrow goes back to them.`,
      amountMicroUsdc: hire.priceUsdc * 1_000_000,
      currency: hire.payCurrency,
      signature: "0xikenga-step2",
      txHash: body.txHash,
      entry: `reject|${hire.payCurrency}|Customer turned the work down.|${hire.priceAtomic}`,
    });
  }
  return NextResponse.json({ job: await getHire(id) });
}
