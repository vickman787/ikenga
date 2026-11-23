/**
 * Naira bills — the Corridors-track job, in the web app.
 *
 * A bill is one person owing a supplier in naira. The form collects the
 * five answers the worker needs; the boss worker does the rest (watch the
 * rate, change USDT to cNGN on Textile FX, pay the supplier). Nothing
 * here moves money and nothing here holds a key: the web server only
 * records the bill and shows where it stands.
 *
 * Bills live in the ledger — Postgres when DATABASE_URL is set, the
 * in-memory MemoryLedger otherwise (same as hires). Each bill carries a
 * hash-chained receipt log (bill_events), so its history can't be
 * rewritten silently. The worker reports progress through
 * POST /api/bills/[id]/update; that route checks swap/payout hashes
 * onchain before recording them (see the route).
 */
import { z } from "zod";
import {
  type BillDecision,
  type BillEvent,
  type BillEventKind,
  type BillPatch,
  type LedgerBill,
} from "@ikenga/ledger";
import { MAX_BILL_NGN, MAX_DEADLINE_DAYS, MIN_BILL_NGN } from "./billConstants";
import { getChainConfig, getLedger } from "./jobs";

export { MAX_BILL_NGN, MAX_DEADLINE_DAYS, MIN_BILL_NGN } from "./billConstants";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export const BillInputSchema = z.object({
  payerName: z.string().trim().min(1, "Tell us your name").max(100),
  purpose: z.string().trim().min(1, "What is the bill for?").max(200),
  amountNgn: z
    .number()
    .int("The amount must be whole naira")
    .min(MIN_BILL_NGN, `The smallest bill that works is ₦${MIN_BILL_NGN.toLocaleString("en-NG")} — about $1, the lowest amount the exchange will change`)
    .max(MAX_BILL_NGN, `Bills above ₦${MAX_BILL_NGN.toLocaleString("en-NG")} are too big for this exchange — talk to us first`),
  supplierWallet: z.string().regex(ADDRESS_RE, "Enter the supplier's Celo wallet address (0x…)"),
  deadline: z.string().refine(
    (v) => {
      const ms = Date.parse(v);
      if (Number.isNaN(ms)) return false;
      const now = Date.now();
      return ms > now && ms <= now + MAX_DEADLINE_DAYS * 24 * 60 * 60 * 1000;
    },
    { message: `Pick a deadline in the future, within ${MAX_DEADLINE_DAYS} days` },
  ),
  minRate: z
    .number()
    .finite("Enter a rate per dollar")
    .gt(0, "Enter the lowest rate per dollar you will accept")
    .lte(100_000, "That rate looks wrong — check it and try again"),
});
export type BillInput = z.infer<typeof BillInputSchema>;

/** What the worker may report for a bill: field updates, an optional receipt, or both. */
export const BillWorkerUpdateSchema = z.object({
  patch: z
    .object({
      status: z.enum(["created", "watching", "converting", "paid", "failed"]).optional(),
      note: z.string().max(500).nullable().optional(),
      lastCheckedAt: z.string().optional(),
      lastRate: z.number().nullable().optional(),
      lastRateAt: z.string().nullable().optional(),
      lastDecision: z.enum(["convert", "refuse", "force-convert", "wait"]).nullable().optional(),
      lastDecisionReason: z.string().max(500).nullable().optional(),
      lastBpsGap: z.number().int().nullable().optional(),
      lastNairaSaved: z.number().int().nullable().optional(),
      fundingNeededUsdt: z.string().max(40).nullable().optional(),
      fundingReady: z.boolean().nullable().optional(),
      rfqId: z.string().max(100).nullable().optional(),
      approvalTxHashes: z.array(z.string().regex(TX_HASH_RE)).max(4).optional(),
      swapTxHash: z.string().regex(TX_HASH_RE).nullable().optional(),
      forced: z.boolean().optional(),
      payoutTxHash: z.string().regex(TX_HASH_RE).nullable().optional(),
    })
    .optional(),
  event: z
    .object({
      kind: z.enum(["created", "quote", "refuse", "convert", "swap", "payout", "paid", "failed", "waiting"]),
      reason: z.string().min(1).max(500),
      rateSeen: z.number().nullable().optional(),
      bpsGap: z.number().int().nullable().optional(),
      txHash: z.string().regex(TX_HASH_RE).nullable().optional(),
    })
    .optional(),
});
export type BillWorkerUpdate = z.infer<typeof BillWorkerUpdateSchema>;

/** A bill as the pages and the API show it. */
export interface BillResult {
  id: string;
  payerName: string;
  purpose: string;
  amountNgn: number;
  supplierWallet: string;
  deadline: string;
  minRate: number;
  status: LedgerBill["status"];
  note: string | null;
  lastCheckedAt: string | null;
  lastRate: number | null;
  lastRateAt: string | null;
  lastDecision: BillDecision | null;
  lastDecisionReason: string | null;
  lastBpsGap: number | null;
  lastNairaSaved: number | null;
  fundingNeededUsdt: string | null;
  fundingReady: boolean | null;
  rfqId: string | null;
  approvalTxHashes: string[];
  swapTxHash: string | null;
  forced: boolean;
  payoutTxHash: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where the transaction links point (Celoscan on mainnet). */
  explorerUrl: string;
}

export function billToResult(b: LedgerBill): BillResult {
  return {
    id: b.id,
    payerName: b.payerName,
    purpose: b.purpose,
    amountNgn: b.amountNgn,
    supplierWallet: b.supplierWallet,
    deadline: b.deadline,
    minRate: b.minRate,
    status: b.status,
    note: b.note,
    lastCheckedAt: b.lastCheckedAt,
    lastRate: b.lastRate,
    lastRateAt: b.lastRateAt,
    lastDecision: b.lastDecision,
    lastDecisionReason: b.lastDecisionReason,
    lastBpsGap: b.lastBpsGap,
    lastNairaSaved: b.lastNairaSaved,
    fundingNeededUsdt: b.fundingNeededUsdt,
    fundingReady: b.fundingReady,
    rfqId: b.rfqId,
    approvalTxHashes: b.approvalTxHashes,
    swapTxHash: b.swapTxHash,
    forced: b.forced,
    payoutTxHash: b.payoutTxHash,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    explorerUrl: getChainConfig().explorerUrl,
  };
}

/** ₦1,500 — whole naira, Nigerian grouping. */
export function formatNaira(amountNgn: number): string {
  return `₦${amountNgn.toLocaleString("en-NG")}`;
}

/** 1444.5 → "₦1,444.50 per $1". */
export function formatRate(rate: number): string {
  return `₦${rate.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per $1`;
}

export async function createBill(input: BillInput): Promise<BillResult> {
  const parsed = BillInputSchema.parse(input);
  const id = `bill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ledger = await getLedger();
  const entry = `created|Bill submitted.|${parsed.amountNgn}`;
  const bill = await ledger.createBill({
    id,
    payerName: parsed.payerName,
    purpose: parsed.purpose,
    amountNgn: parsed.amountNgn,
    supplierWallet: parsed.supplierWallet,
    deadline: new Date(parsed.deadline).toISOString(),
    minRate: parsed.minRate,
  });
  await ledger.appendBillEvent({
    id: `bev_${id}`,
    billId: id,
    kind: "created",
    reason: `Bill submitted: ${formatNaira(parsed.amountNgn)} for ${parsed.purpose}.`,
    rateSeen: null,
    bpsGap: null,
    txHash: null,
    entry,
  });
  return billToResult(bill);
}

export async function getBill(id: string): Promise<BillResult | null> {
  const ledger = await getLedger();
  const bill = await ledger.getBill(id);
  return bill ? billToResult(bill) : null;
}

export async function listBills(): Promise<BillResult[]> {
  const ledger = await getLedger();
  return (await ledger.listBills()).map(billToResult);
}

export async function getBillEvents(id: string): Promise<BillEvent[]> {
  const ledger = await getLedger();
  return ledger.listBillEvents(id);
}

export async function verifyBillEvents(id: string): Promise<boolean> {
  const ledger = await getLedger();
  return ledger.verifyBillChain(id);
}

/**
 * Apply a worker report: field updates, a receipt, or both. The route
 * checks any swap/payout hash onchain before calling this — never record
 * a transaction that didn't happen.
 */
export async function applyBillUpdate(id: string, input: BillWorkerUpdate): Promise<BillResult | null> {
  const parsed = BillWorkerUpdateSchema.parse(input);
  const ledger = await getLedger();
  const bill = await ledger.getBill(id);
  if (!bill) return null;
  if (parsed.patch) {
    await ledger.updateBill(id, parsed.patch as BillPatch);
  }
  if (parsed.event) {
    const e = parsed.event;
    await ledger.appendBillEvent({
      id: `bev_${id}_${Date.now()}`,
      billId: id,
      kind: e.kind as BillEventKind,
      reason: e.reason,
      rateSeen: e.rateSeen ?? null,
      bpsGap: e.bpsGap ?? null,
      txHash: e.txHash ?? null,
      entry: `${e.kind}|${e.reason}|${e.rateSeen ?? ""}`,
    });
  }
  const updated = await ledger.getBill(id);
  return updated ? billToResult(updated) : null;
}
