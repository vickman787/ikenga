/**
 * Naira bills — the boss worker's half of the Corridors flow.
 *
 * A bill is one person owing a supplier in naira. The worker watches it
 * every run (the 5-minute cron) and does the money part the web server
 * cannot: it checks the live Textile FX rate, changes USDT to cNGN, and
 * pays the supplier in cNGN — only at the rate the payer named, or at
 * the deadline.
 *
 * Money rules, in order:
 *   1. The supplier must not be the agent wallet itself.
 *   2. A free preview says what the swap costs (rate + USDT needed). The
 *      rate is what the bill actually costs, fee included
 *      (buyAmount / takerPays) — never the headline rate before fees.
 *   3. The agent wallet must already hold that USDT, plus a little CELO
 *      for gas — and the USDT must be THIS bill's own verified funding.
 *      A bill is funded by its recorded funding transfers (payer wallet
 *      + tx hash + amount), never by "the wallet has enough USDT", so two
 *      bills can never claim the same payment. Short of it, the bill
 *      waits and the page says exactly how much USDT is needed — or how
 *      much more, when the friend already paid part of it. If the rate
 *      moved since they paid and the swap now needs more, the bill waits
 *      for the difference; if it needs less, the swap goes ahead and the
 *      extra stays in the agent wallet. Nothing is borrowed, nothing is
 *      promised.
 *   4. Below the minimum rate and before the deadline, the worker
 *      refuses (decideFx) and writes a receipt for what waiting saved.
 *      A refusal is recorded once, not every run.
 *   5. At or above the minimum — or at the deadline — a firm quote is
 *      requested and decideFx makes the call. A refused firm quote is
 *      cancelled, so the maker's slot is freed.
 *   6. The swap goes through executeSwap with a split sender: the USDT
 *      approval is tagged (sendTagged), the swap itself is broadcast
 *      EXACTLY as Textile returned it — never re-tagged (textile.ts
 *      documents why: the indexer reads only the last tag, and the swap
 *      already carries Textile's tag — risk R-5).
 *   7. The cNGN payout to the supplier goes through sendTagged, so it
 *      carries Ikenga's tag. That is the transaction the tracker counts.
 *   8. Every step is resumable: a swap with no payout yet is picked up
 *      by the next run, and a failed payout leaves the bill converting,
 *      not paid.
 *
 * Before the swap and before the payout, Investigator checks the
 * contracts and the payout itself onchain (investigator.ts): the USDT
 * token and the swap contract must be real contracts, the supplier
 * must be a real address (not the zero address, not the agent wallet),
 * and the payout must be a plain transfer of exactly the bill's
 * amount to exactly the supplier. A failed check fails the bill and
 * nothing moves; an unreadable chain waits for the next run. Each
 * passed check is written down as a "checked" receipt on the bill.
 * There is no sanctions, KYC or OFAC check — we have no such check,
 * and nothing here claims one.
 *
 * No step here runs on Sepolia — there is no Celo testnet corridor, so
 * the worker only processes bills on mainnet (the boss worker enforces
 * that). No live swap is possible in tests: the pipeline takes a
 * BillRuntime, and unit tests inject fakes.
 */
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import {
  appendAttribution,
  parseAttribution,
  type FirmQuote,
  type FirmQuoteResult,
  type PreviewResult,
  type SendFn,
  type TextileTx,
} from "@ikenga/payments";
import { decideFx } from "./fx.js";
import { investigateBillPayout, investigateBillSwap } from "./investigator.js";
import type { BillDecision } from "@ikenga/ledger";

export const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;
export const CNGN_ADDRESS = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address;
export const TEXTILE_REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address;

/** The bill in cNGN, as atomic units (6 decimals). */
export function billBuyAmountAtomic(amountNgn: number): string {
  if (!Number.isInteger(amountNgn) || amountNgn <= 0) {
    throw new Error("amountNgn must be a positive whole number of naira");
  }
  return (BigInt(amountNgn) * 1_000_000n).toString();
}

/**
 * The true rate of a quote: cNGN the bill gets per 1 USDT actually spent
 * — buyAmount / takerPays, fee included. Never the pre-fee rate.
 */
export function quoteRate(buyAmount: string, takerPays: string): number {
  const buy = BigInt(buyAmount);
  const pays = BigInt(takerPays);
  if (pays <= 0n) throw new Error("takerPays must be > 0");
  return Number((buy * 1_000_000n) / pays) / 1_000_000;
}

/** USDT as a plain decimal string, from atomic units ("1052341" -> "1.052341"). */
export function formatUsdtAtomic(atomic: string): string {
  const v = BigInt(atomic);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** The cNGN payout call: transfer(amount) from the agent wallet to the supplier. Pure — it sends nothing. */
export function payoutCalldata(supplier: string, amountAtomic: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(supplier)) throw new Error("supplier must be an EVM address");
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [supplier as Address, BigInt(amountAtomic)],
  });
}

/**
 * The payout calldata with Ikenga's tag on it — the byte-level check the
 * worker's payout must pass. Returns the tagged calldata and the codes
 * the tag parser reads back, so a test (or a log) can prove the tag is
 * there without sending anything.
 */
export function taggedPayoutCalldata(supplier: string, amountAtomic: string, tag: string): { tagged: Hex; codes: string[] } {
  const data = payoutCalldata(supplier, amountAtomic);
  const tagged = appendAttribution(data, tag);
  const parsed = parseAttribution(tagged);
  return { tagged, codes: parsed?.codes ?? [] };
}

/**
 * The sender executeSwap gets for a bill. Two rules, both from textile.ts:
 * approvals go through sendTagged (they carry Ikenga's tag); the swap
 * itself is broadcast EXACTLY as Textile returned it — never re-tagged.
 * The swap is recognised by exact calldata match: nothing else in this
 * flow sends that data.
 */
export function makeBillSendFn(deps: {
  sendTagged: (tx: TextileTx) => Promise<string>;
  sendRaw: (tx: TextileTx) => Promise<string>;
  swapData: string;
}): SendFn {
  const swap = deps.swapData.toLowerCase();
  return async (tx: TextileTx) => (tx.data.toLowerCase() === swap ? deps.sendRaw(tx) : deps.sendTagged(tx));
}

/** A bill as the worker sees it from the site's /api/bills. */
export interface SiteBill {
  id: string;
  payerName: string;
  purpose: string;
  amountNgn: number;
  supplierWallet: string;
  deadline: string;
  minRate: number;
  status: string;
  note: string | null;
  lastDecision: BillDecision | null;
  fundingNeededUsdt: string | null;
  fundingReady: boolean | null;
  /** The wallet that paid for this bill — the friend's own wallet. */
  fundingPayerWallet: string | null;
  /** Verified funding transfers for this bill. A hash is recorded on one bill only. */
  fundingTxHashes: string[];
  /** Total USDT paid for this bill across its verified funding transfers, in atomic units. */
  fundingPaidUsdtAtomic: string | null;
  rfqId: string | null;
  approvalTxHashes: string[];
  swapTxHash: string | null;
  forced: boolean;
  payoutTxHash: string | null;
}

export interface BillUpdate {
  patch?: Record<string, unknown>;
  event?: {
    kind: string;
    reason: string;
    rateSeen?: number | null;
    bpsGap?: number | null;
    txHash?: string | null;
  };
}

/** Everything the bill pipeline needs from the outside world, injected so tests can fake it. */
export interface BillRuntime {
  /** The agent wallet — the taker of the swap and the payer of the cNGN. */
  takerAddress: string;
  /** Free, indicative quote: rate + what the swap needs. No taker, no key. */
  preview(buyAmountAtomic: string): Promise<PreviewResult>;
  /** Firm quote (blocks while makers answer; keyless proof handled inside). */
  firmQuote(buyAmountAtomic: string): Promise<FirmQuoteResult>;
  /** Release a quoted RFQ's maker inventory. Best-effort — the slot frees itself at expiry. */
  cancelQuote(rfqId: string, claimToken?: string): Promise<void>;
  usdtBalanceOf(owner: string): Promise<bigint>;
  cngnBalanceOf(owner: string): Promise<bigint>;
  celoBalanceOf(owner: string): Promise<bigint>;
  /** Contract code at an address ("" / "0x" / null when there is none) —
   * Investigator's onchain reads, before a swap or a payout is sent. */
  codeAt(address: string): Promise<string | null | undefined>;
  getAllowance(token: string, owner: string, spender: string): Promise<bigint>;
  waitForReceipt(hash: string): Promise<{ status: "success" | "reverted" }>;
  /** Null while the transaction is still unmined. */
  getReceipt(hash: string): Promise<{ status: "success" | "reverted" } | null>;
  executeSwap(
    quote: FirmQuote,
    sendFn: SendFn,
    opts: {
      waitForReceipt: (hash: string) => Promise<unknown>;
      getAllowance: (token: string, owner: string, spender: string) => Promise<bigint>;
      requireAttribution?: boolean;
    },
  ): Promise<{ txHash: string; approvalTxHashes: string[]; attributionTagged: boolean; submitted: boolean }>;
  /** Tagged send (Ikenga's tag) — approvals and the cNGN payout. */
  sendTagged(tx: TextileTx): Promise<string>;
  /** Untagged send — the swap itself, exactly as Textile returned it. */
  sendRaw(tx: TextileTx): Promise<string>;
  updateBill(id: string, update: BillUpdate): Promise<void>;
  nowIso(): string;
  log(msg: string): void;
}

export interface BillProcessResult {
  checked: number;
  converted: number;
  paid: number;
  refused: number;
  waiting: number;
  failed: number;
  actionsUsed: number;
}

type BillOutcome = "converted" | "paid" | "refused" | "waiting" | "failed";

const ACTIVE_BILL_STATUSES = new Set(["created", "watching", "converting"]);

export async function processBills(bills: SiteBill[], rt: BillRuntime, actionsLeft: number): Promise<BillProcessResult> {
  const result: BillProcessResult = { checked: 0, converted: 0, paid: 0, refused: 0, waiting: 0, failed: 0, actionsUsed: 0 };
  for (const bill of bills) {
    if (result.actionsUsed >= actionsLeft) break;
    if (!ACTIVE_BILL_STATUSES.has(bill.status)) continue;
    result.checked += 1;
    const one = await processOneBill(bill, rt, actionsLeft - result.actionsUsed);
    result.actionsUsed += one.actionsUsed;
    if (one.outcome === "converted") result.converted += 1;
    if (one.outcome === "paid") result.paid += 1;
    if (one.outcome === "refused") result.refused += 1;
    if (one.outcome === "waiting") result.waiting += 1;
    if (one.outcome === "failed") result.failed += 1;
  }
  return result;
}

async function processOneBill(
  bill: SiteBill,
  rt: BillRuntime,
  actionsLeft: number,
): Promise<{ actionsUsed: number; outcome: BillOutcome }> {
  const now = rt.nowIso();

  // 1. A bill can't pay the agent wallet itself — that would be the team paying itself.
  if (bill.supplierWallet.toLowerCase() === rt.takerAddress.toLowerCase()) {
    await rt.updateBill(bill.id, {
      patch: {
        status: "failed",
        lastCheckedAt: now,
        note: "The supplier wallet is the agent wallet itself — a bill can't pay itself.",
      },
      event: { kind: "failed", reason: "Supplier wallet is the agent wallet itself." },
    });
    return { actionsUsed: 0, outcome: "failed" };
  }

  const buyAmount = billBuyAmountAtomic(bill.amountNgn);

  // 2. Resume: the swap is already sent, the payout isn't.
  if (bill.status === "converting" && bill.swapTxHash) {
    return resumeConverting(bill, rt, actionsLeft);
  }

  // 3. Preview — free, and it says both the rate and what the swap needs.
  let preview: PreviewResult;
  try {
    preview = await rt.preview(buyAmount);
  } catch (err) {
    rt.log(`bill ${bill.id}: could not check the rate right now — leaving it for the next run. (${err instanceof Error ? err.message : "unknown error"})`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (preview.kind === "no_quote") {
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: now,
        note: "No one is offering this swap right now — checking again in a few minutes.",
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }
  const rate = quoteRate(preview.buyAmount, preview.takerPays);
  const neededUsdt = formatUsdtAtomic(preview.takerPays);

  // 4. Funding: this bill's own verified funding must cover the swap,
  // and the agent wallet must still hold that USDT, plus a little CELO
  // for gas. A bill is funded by ITS OWN recorded funding transfers —
  // never by "the wallet has enough USDT" — so two bills can never
  // claim the same payment. If the rate moved since the friend paid and
  // the swap now needs more, the bill waits and the page says the
  // shortfall; if it needs less, the swap goes ahead.
  const neededAtomic = BigInt(preview.takerPays);
  const paidAtomic = bill.fundingPaidUsdtAtomic ? BigInt(bill.fundingPaidUsdtAtomic) : 0n;
  let usdt: bigint;
  let celo: bigint;
  try {
    [usdt, celo] = await Promise.all([rt.usdtBalanceOf(rt.takerAddress), rt.celoBalanceOf(rt.takerAddress)]);
  } catch (err) {
    rt.log(`bill ${bill.id}: could not check the agent wallet balance — leaving it for the next run. (${err instanceof Error ? err.message : "unknown error"})`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (paidAtomic < neededAtomic) {
    const shortfall = formatUsdtAtomic((neededAtomic - paidAtomic).toString());
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: now,
        lastRate: rate,
        lastRateAt: now,
        fundingNeededUsdt: neededUsdt,
        fundingReady: false,
        note:
          paidAtomic === 0n
            ? `To pay this bill we need about $${Number(neededUsdt).toFixed(2)} USDT from your own wallet. Nothing has moved yet.`
            : `You paid $${Number(formatUsdtAtomic(paidAtomic.toString())).toFixed(2)} USDT — we need $${Number(shortfall).toFixed(2)} more for this bill at the rate right now. Nothing has moved yet.`,
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (usdt < neededAtomic) {
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: now,
        lastRate: rate,
        lastRateAt: now,
        fundingNeededUsdt: neededUsdt,
        fundingReady: false,
        note: "Your payment for this bill is recorded, but the agent wallet no longer holds enough USDT to pay it — nothing can move until it does.",
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (celo === 0n) {
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: now,
        lastRate: rate,
        lastRateAt: now,
        fundingNeededUsdt: neededUsdt,
        fundingReady: true,
        note: "The USDT is there, but the agent wallet has no CELO for gas — nothing can move until it does.",
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }

  // 5. Below the minimum and before the deadline: refuse, and write the receipt once.
  const pastDeadline = Date.parse(now) >= Date.parse(bill.deadline);
  if (rate < bill.minRate && !pastDeadline) {
    const decision = decideFx({
      obligationNaira: bill.amountNgn,
      minRate: bill.minRate,
      deadline: bill.deadline,
      now,
      quote: { rate, expiresAt: new Date(Date.parse(now) + 60_000).toISOString() },
    });
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: now,
        lastRate: rate,
        lastRateAt: now,
        lastDecision: "refuse",
        lastDecisionReason: decision.reason,
        lastBpsGap: decision.bpsGap ?? null,
        lastNairaSaved: decision.nairaSaved ?? null,
        fundingNeededUsdt: neededUsdt,
        fundingReady: true,
        note: `The rate right now is ₦${rate.toLocaleString("en-NG")} per $1 — below the ₦${bill.minRate.toLocaleString("en-NG")} minimum. Waiting, and the money stays put.`,
      },
      // One refusal receipt per bill — not one every five minutes.
      event:
        bill.lastDecision === "refuse"
          ? undefined
          : { kind: "refuse", reason: decision.reason, rateSeen: rate, bpsGap: decision.bpsGap ?? null },
    });
    return { actionsUsed: 0, outcome: "refused" };
  }

  // 6. Firm quote, then the pure decision.
  let firm: FirmQuoteResult;
  try {
    firm = await rt.firmQuote(buyAmount);
  } catch (err) {
    rt.log(`bill ${bill.id}: could not get a firm quote — leaving it for the next run. (${err instanceof Error ? err.message : "unknown error"})`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (firm.kind === "no_quote") {
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: now,
        lastRate: rate,
        lastRateAt: now,
        fundingNeededUsdt: neededUsdt,
        fundingReady: true,
        note: "The rate looked good, but no one would hold a firm price for it — checking again in a few minutes.",
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }
  const quote = firm.quote;
  const firmRate = quoteRate(quote.buyAmount, quote.takerPays);
  const decision = decideFx({
    obligationNaira: bill.amountNgn,
    minRate: bill.minRate,
    deadline: bill.deadline,
    now: rt.nowIso(),
    quote: { rate: firmRate, expiresAt: quote.expiresAt },
  });
  if (decision.action === "refuse" || decision.action === "wait") {
    // Free the maker's slot, then record the refusal (once).
    try {
      await rt.cancelQuote(quote.rfqId, quote.claimToken);
    } catch {
      // The slot frees itself when the quote expires.
    }
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: rt.nowIso(),
        lastRate: firmRate,
        lastRateAt: rt.nowIso(),
        lastDecision: decision.action,
        lastDecisionReason: decision.reason,
        lastBpsGap: decision.bpsGap ?? null,
        lastNairaSaved: decision.nairaSaved ?? null,
        fundingNeededUsdt: neededUsdt,
        fundingReady: true,
        note: `The firm rate is ₦${firmRate.toLocaleString("en-NG")} per $1 — below the ₦${bill.minRate.toLocaleString("en-NG")} minimum. Waiting, and the money stays put.`,
      },
      event:
        bill.lastDecision === decision.action
          ? undefined
          : { kind: "refuse", reason: decision.reason, rateSeen: firmRate, bpsGap: decision.bpsGap ?? null },
    });
    return { actionsUsed: 0, outcome: decision.action === "refuse" ? "refused" : "waiting" };
  }

  // 7. Convert (or force-convert at the deadline). The swap needs the
  // swap tx plus the payout — leave it for the next run if the run is
  // nearly out of actions.
  if (actionsLeft < 2) {
    rt.log(`bill ${bill.id}: the rate is good but the run is nearly out of actions — leaving the swap for the next run.`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  // Investigator checks the swap contracts before the swap is sent:
  // the USDT token and the swap contract must both be real contracts
  // on Celo. An unreadable chain waits for the next run; a failed
  // check fails the bill, in plain words, and nothing moves.
  const swapCheck = await investigateBillSwap(
    { usdtAddress: USDT_ADDRESS, reactorAddress: TEXTILE_REACTOR },
    { codeAt: rt.codeAt },
  );
  if (!swapCheck.readable) {
    rt.log(`bill ${bill.id}: could not check the swap contracts onchain — leaving it for the next run.`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (!swapCheck.passed) {
    await rt.updateBill(bill.id, {
      patch: {
        status: "failed",
        lastCheckedAt: rt.nowIso(),
        note: `${swapCheck.summary} Nothing moved.`,
      },
      event: { kind: "failed", reason: swapCheck.summary },
    });
    return { actionsUsed: 0, outcome: "failed" };
  }
  await rt.updateBill(bill.id, {
    event: { kind: "checked", reason: swapCheck.summary },
  });
  const sendFn = makeBillSendFn({ sendTagged: rt.sendTagged, sendRaw: rt.sendRaw, swapData: quote.transactions.swap.data });
  let executed: { txHash: string; approvalTxHashes: string[]; attributionTagged: boolean; submitted: boolean };
  try {
    executed = await rt.executeSwap(quote, sendFn, {
      waitForReceipt: async (hash: string) => rt.waitForReceipt(hash),
      getAllowance: rt.getAllowance,
      requireAttribution: true,
    });
  } catch (err) {
    // Expired quote, reverted approval, no makers — nothing moved (or the
    // approval did and the swap didn't; the next run re-checks the allowance).
    await rt.updateBill(bill.id, {
      patch: {
        status: "watching",
        lastCheckedAt: rt.nowIso(),
        lastRate: firmRate,
        lastRateAt: rt.nowIso(),
        note: `The swap didn't go through this time — nothing moved, trying again in a few minutes. (${err instanceof Error ? err.message : "unknown error"})`,
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }
  const actionsUsed = executed.approvalTxHashes.length + 1;
  await rt.updateBill(bill.id, {
    patch: {
      status: "converting",
      rfqId: quote.rfqId,
      approvalTxHashes: executed.approvalTxHashes,
      swapTxHash: executed.txHash,
      forced: decision.action === "force-convert",
      lastDecision: decision.action,
      lastDecisionReason: decision.reason,
      lastBpsGap: decision.bpsGap ?? null,
      lastCheckedAt: rt.nowIso(),
    },
    event: {
      kind: "swap",
      reason:
        decision.action === "force-convert"
          ? `Deadline reached — changed USDT to cNGN at ₦${firmRate.toLocaleString("en-NG")} per $1, below the minimum, and recorded the concession.`
          : `Changed USDT to cNGN at ₦${firmRate.toLocaleString("en-NG")} per $1.`,
      rateSeen: firmRate,
      bpsGap: decision.bpsGap ?? null,
      txHash: executed.txHash,
    },
  });

  // 8. Pay the supplier in the same run when the cNGN is there.
  const paid = await paySupplier({ ...bill, status: "converting", swapTxHash: executed.txHash }, rt, actionsLeft - actionsUsed);
  return {
    actionsUsed: actionsUsed + paid.actionsUsed,
    outcome: paid.outcome === "paid" ? "paid" : paid.outcome === "failed" ? "failed" : "converted",
  };
}

/** A swap already sent: check it landed, then pay the supplier. */
async function resumeConverting(
  bill: SiteBill,
  rt: BillRuntime,
  actionsLeft: number,
): Promise<{ actionsUsed: number; outcome: BillOutcome }> {
  const receipt = await rt.getReceipt(bill.swapTxHash as string);
  if (!receipt) {
    rt.log(`bill ${bill.id}: swap ${bill.swapTxHash} is still on its way — leaving it for the next run.`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (receipt.status !== "success") {
    await rt.updateBill(bill.id, {
      patch: {
        status: "failed",
        lastCheckedAt: rt.nowIso(),
        note: "The swap didn't go through onchain — nothing was paid.",
      },
      event: { kind: "failed", reason: "The swap reverted onchain — nothing was paid.", txHash: bill.swapTxHash },
    });
    return { actionsUsed: 0, outcome: "failed" };
  }
  return paySupplier(bill, rt, actionsLeft);
}

/** Pay the supplier the bill's cNGN from the agent wallet, tagged. */
async function paySupplier(
  bill: SiteBill,
  rt: BillRuntime,
  actionsLeft: number,
): Promise<{ actionsUsed: number; outcome: "paid" | "waiting" | "failed" }> {
  if (actionsLeft < 1) {
    rt.log(`bill ${bill.id}: the swap is done but the run is out of actions — the payout waits for the next run.`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  const amountAtomic = billBuyAmountAtomic(bill.amountNgn);
  let balance: bigint;
  try {
    balance = await rt.cngnBalanceOf(rt.takerAddress);
  } catch (err) {
    rt.log(`bill ${bill.id}: could not check the cNGN balance — leaving the payout for the next run. (${err instanceof Error ? err.message : "unknown error"})`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (balance < BigInt(amountAtomic)) {
    await rt.updateBill(bill.id, {
      patch: {
        status: "converting",
        lastCheckedAt: rt.nowIso(),
        note: "The swap went through, but the wallet holds less cNGN than the bill needs — waiting before paying the supplier.",
      },
    });
    return { actionsUsed: 0, outcome: "waiting" };
  }
  const data = payoutCalldata(bill.supplierWallet, amountAtomic);
  // Investigator checks the payout before the cNGN is sent: the
  // supplier, the amount in the payout itself, and the cNGN token.
  // An unreadable chain waits for the next run; a failed check fails
  // the bill, in plain words, and nothing is paid.
  const payoutCheck = await investigateBillPayout(
    {
      supplierWallet: bill.supplierWallet,
      agentWallet: rt.takerAddress,
      amountNgn: bill.amountNgn,
      cngnAddress: CNGN_ADDRESS,
      payoutData: data,
    },
    { codeAt: rt.codeAt },
  );
  if (!payoutCheck.readable) {
    rt.log(`bill ${bill.id}: could not check the payout onchain — leaving it for the next run.`);
    return { actionsUsed: 0, outcome: "waiting" };
  }
  if (!payoutCheck.passed) {
    await rt.updateBill(bill.id, {
      patch: {
        status: "failed",
        lastCheckedAt: rt.nowIso(),
        note: `${payoutCheck.summary} Nothing was paid.`,
      },
      event: { kind: "failed", reason: payoutCheck.summary },
    });
    return { actionsUsed: 0, outcome: "failed" };
  }
  await rt.updateBill(bill.id, {
    event: { kind: "checked", reason: payoutCheck.summary },
  });
  const hash = await rt.sendTagged({ to: CNGN_ADDRESS, data, value: "0" });
  const receipt = await rt.waitForReceipt(hash);
  if (receipt.status !== "success") {
    await rt.updateBill(bill.id, {
      patch: {
        status: "converting",
        lastCheckedAt: rt.nowIso(),
        note: "The payment to the supplier didn't go through onchain — nothing was paid, trying again.",
      },
      event: { kind: "failed", reason: "The cNGN payout reverted onchain — nothing was paid.", txHash: hash },
    });
    return { actionsUsed: 1, outcome: "waiting" };
  }
  await rt.updateBill(bill.id, {
    patch: { status: "paid", payoutTxHash: hash, lastCheckedAt: rt.nowIso() },
    event: {
      kind: "payout",
      reason: `Paid ${bill.amountNgn.toLocaleString("en-NG")} naira to the supplier in cNGN.`,
      txHash: hash,
    },
  });
  return { actionsUsed: 1, outcome: "paid" };
}
