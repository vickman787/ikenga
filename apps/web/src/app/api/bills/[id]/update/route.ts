import { NextResponse } from "next/server";
import { CELO_TOKENS, TEXTILE_FX_LIMIT_ORDER_REACTOR, verifyFundingTransfer, verifyTxReceipt } from "@ikenga/payments";
import {
  applyBillUpdate,
  BillFundingReportSchema,
  BillWorkerUpdateSchema,
  findBillByFundingTxHash,
  getBill,
  recordBillFunding,
} from "@/lib/bills";
import { getChainConfig } from "@/lib/jobs";

/**
 * POST /api/bills/[id]/update — the boss worker's receipt for a bill,
 * and the payer's funding report.
 *
 * Body: { patch?, event?, funding? } — field updates, a receipt, or a
 * funding report (see BillWorkerUpdateSchema and
 * BillFundingReportSchema). The boss is the only one who watches the
 * rate and moves the money; the payer only ever reports a funding
 * transfer they already made from their own wallet.
 *
 * Nothing is taken on trust: a swap hash must have succeeded onchain and
 * called the Textile reactor; a payout hash must have succeeded and
 * called the cNGN token; an approval hash must have succeeded and called
 * USDT. A funding hash must have succeeded onchain as a USDT transfer
 * from the payer's wallet to the agent wallet, for exactly the amount
 * reported — and it must not already be recorded on another bill. A hash
 * that fails those checks is refused with 400. Re-posting a hash already
 * recorded is a no-op — the worker and the payer's browser retry safely.
 *
 * Bills run on Celo mainnet only (there is no Celo testnet corridor), so
 * this route refuses to record anything while the site runs on another chain.
 */
const UpdateBodySchema = BillWorkerUpdateSchema.extend({
  funding: BillFundingReportSchema.optional(),
});

const FUNDING_REASONS: Record<string, string> = {
  "not onchain yet": "That payment hasn't landed onchain yet — wait a moment and try again.",
  reverted: "That payment didn't go through onchain — check the transaction and try again.",
  "wrong token": "That transaction didn't call the USDT token — check the transaction hash and try again.",
  "wrong payer": "That payment came from a different wallet than the one you connected — check the wallet and try again.",
  "wrong recipient": "That payment didn't go to the agent wallet — check the transaction hash and try again.",
  "wrong amount": "That payment was for a different amount than the one reported — check the amount and try again.",
  "not a transfer": "That transaction isn't a USDT transfer — check the transaction hash and try again.",
};

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
  const parsed = UpdateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid update." }, { status: 400 });
  }
  const { patch, funding } = parsed.data;

  // A funding report: check the transfer onchain before recording it.
  // The hash belongs to one bill only — another bill already holding it
  // means this payment is being claimed twice.
  if (funding) {
    if (bill.fundingTxHashes.includes(funding.txHash)) {
      return NextResponse.json({ bill });
    }
    const claimed = await findBillByFundingTxHash(funding.txHash);
    if (claimed && claimed.id !== id) {
      return NextResponse.json(
        { error: "That payment is already recorded on another bill — one payment can't fund two bills." },
        { status: 400 },
      );
    }
    let check;
    try {
      check = await verifyFundingTransfer(funding.txHash, {
        token: CELO_TOKENS.USDT.address,
        from: funding.payerWallet,
        recipient: config.agentWallet,
        amountAtomic: BigInt(funding.amountAtomic),
      });
    } catch (err) {
      return NextResponse.json(
        { error: `Could not check the funding payment onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})` },
        { status: 502 },
      );
    }
    if (!check.ok) {
      return NextResponse.json(
        { error: FUNDING_REASONS[check.reason ?? ""] ?? "That funding payment didn't check out onchain — check the transaction hash and try again." },
        { status: 400 },
      );
    }
    try {
      const funded = await recordBillFunding(id, funding);
      if (!parsed.data.patch && !parsed.data.event) {
        return NextResponse.json({ bill: funded });
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Could not record the funding payment." },
        { status: 400 },
      );
    }
  }

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
