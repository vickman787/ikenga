import { NextResponse } from "next/server";
import { CELO_TOKENS, TEXTILE_FX_LIMIT_ORDER_REACTOR, verifyTxReceipt } from "@ikenga/payments";
import { applyBillUpdate, BillWorkerUpdateSchema, getBill } from "@/lib/bills";
import { getChainConfig } from "@/lib/jobs";

/**
 * POST /api/bills/[id]/update — the boss worker's receipt for a bill.
 *
 * Body: { patch?, event? } — field updates, a receipt, or both (see
 * BillWorkerUpdateSchema). The boss is the only one who watches the rate
 * and moves the money, so this route is the worker's receipt, not the
 * payer's: the payer never calls it.
 *
 * Nothing is taken on trust: a swap hash must have succeeded onchain and
 * called the Textile reactor; a payout hash must have succeeded and
 * called the cNGN token; an approval hash must have succeeded and called
 * USDT. A hash that fails those checks is refused with 400. Re-posting a
 * hash already recorded is a no-op — the worker retries safely.
 *
 * Bills run on Celo mainnet only (there is no Celo testnet corridor), so
 * this route refuses to record anything while the site runs on another chain.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const config = getChainConfig();
  if (config.chainId !== 42220) {
    return NextResponse.json(
      { error: "Naira bills run on Celo mainnet only — there is no testnet corridor." },
      { status: 400 },
    );
  }
  const bill = await getBill(id);
  if (!bill) return NextResponse.json({ error: "No bill with that id." }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as unknown;
  const parsed = BillWorkerUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid update." }, { status: 400 });
  }
  const { patch } = parsed.data;

  // Check every new transaction hash onchain before recording it.
  const checks: { label: string; hash: string; to: string }[] = [];
  if (patch?.swapTxHash && patch.swapTxHash !== bill.swapTxHash) {
    checks.push({ label: "swap", hash: patch.swapTxHash, to: TEXTILE_FX_LIMIT_ORDER_REACTOR });
  }
  if (patch?.payoutTxHash && patch.payoutTxHash !== bill.payoutTxHash) {
    checks.push({ label: "payout", hash: patch.payoutTxHash, to: CELO_TOKENS.cNGN.address });
  }
  for (const hash of patch?.approvalTxHashes ?? []) {
    if (!bill.approvalTxHashes.includes(hash)) {
      checks.push({ label: "approval", hash, to: CELO_TOKENS.USDT.address });
    }
  }
  for (const check of checks) {
    let receipt;
    try {
      receipt = await verifyTxReceipt(check.hash as `0x${string}`);
    } catch (err) {
      return NextResponse.json(
        { error: `Could not check the ${check.label} onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})` },
        { status: 502 },
      );
    }
    if (!receipt.ok) {
      return NextResponse.json({ error: `That ${check.label} didn't go through onchain — check the transaction hash and try again.` }, { status: 400 });
    }
    if (receipt.to?.toLowerCase() !== check.to.toLowerCase()) {
      return NextResponse.json({ error: `That ${check.label} didn't call the right contract — check the transaction hash and try again.` }, { status: 400 });
    }
  }

  const updated = await applyBillUpdate(id, parsed.data);
  if (!updated) return NextResponse.json({ error: "No bill with that id." }, { status: 404 });
  return NextResponse.json({ bill: updated });
}
