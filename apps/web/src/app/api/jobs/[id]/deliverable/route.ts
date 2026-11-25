import { requireJobAccess } from "@/lib/jobAccess";
import { NextResponse } from "next/server";
import {
  getChainConfig,
  getHire,
  getLedger,
  readEscrowDeliverableHash,
  verifyTxReceipt,
} from "@/lib/jobs";

/**
 * POST /api/jobs/[id]/deliverable — record that the delivered work's
 * hash has been sealed on the job's escrow.
 *
 * Body: { txHash } — the boss worker's vault.submitDeliverable()
 * transaction. The boss is the only one who can seal (the vault only
 * takes it from its boss), so this route is the worker's receipt, not
 * the customer's: the customer never calls it.
 *
 * Nothing is taken on trust: the receipt must have succeeded and the
 * transaction must have called Ikenga's vault, and the escrow itself
 * must now carry a sealed (non-zero) deliverable hash. Only then is
 * the seal tx recorded and the decision logged. Re-posting the same
 * tx hash is a no-op — the worker retries safely.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denial = await requireJobAccess(req, id);
  if (denial) return denial;
  const hire = await getHire(id);
  if (!hire) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? "")) {
    return NextResponse.json(
      { error: "Send the transaction hash for the deliverable seal, so it can be checked onchain." },
      { status: 400 },
    );
  }
  if (!hire.escrowAddress) {
    return NextResponse.json(
      { error: "There's no escrow for this job yet, so there's no deliverable to seal." },
      { status: 400 },
    );
  }
  // Already recorded — the worker retrying a seal it already reported.
  if (hire.deliverableTxHash === body.txHash) {
    return NextResponse.json({ job: hire });
  }
  const config = getChainConfig();
  let receipt;
  try {
    receipt = await verifyTxReceipt(body.txHash as `0x${string}`);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not check the seal onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`,
      },
      { status: 502 },
    );
  }
  if (!receipt.ok) {
    return NextResponse.json(
      { error: "That seal didn't go through onchain — check the transaction hash and try again." },
      { status: 400 },
    );
  }
  if (receipt.to?.toLowerCase() !== config.vaultAddress.toLowerCase()) {
    return NextResponse.json(
      { error: "That transaction didn't call Ikenga's vault — the deliverable is sealed through the vault, so check the transaction hash and try again." },
      { status: 400 },
    );
  }
  let sealedHash;
  try {
    sealedHash = await readEscrowDeliverableHash(hire.escrowAddress as `0x${string}`);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not check the escrow onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`,
      },
      { status: 502 },
    );
  }
  if (!sealedHash) {
    return NextResponse.json(
      { error: "The deliverable hasn't been sealed on the escrow yet — the seal may still be on its way." },
      { status: 400 },
    );
  }
  const ledger = await getLedger();
  await ledger.updateOrderEscrow(id, { deliverableTxHash: body.txHash });
  await ledger.appendDecision({
    id: `dec_${id}_deliverable_${Date.now()}`,
    orderId: id,
    kind: "escrow",
    reason: "Deliverable sealed onchain.",
    amountMicroUsdc: hire.priceUsdc * 1_000_000,
    signature: "0xikenga-step2",
    txHash: body.txHash,
    entry: `escrow|Deliverable sealed onchain.|${hire.priceUsdc * 1_000_000}`,
  });
  return NextResponse.json({ job: await getHire(id) });
}
