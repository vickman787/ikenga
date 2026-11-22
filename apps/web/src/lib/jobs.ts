/**
 * Step 2 hire flow, Step 3 persistence fix.
 *
 * Hires and reports live in the ledger — Postgres when DATABASE_URL is
 * set, the in-memory MemoryLedger otherwise (dev/demo, lost on restart).
 * Nothing about a hire lives only in server memory any more: on Vercel
 * each request can land on a different serverless instance, so a hire
 * made on one instance must be readable from the next. The $1 quote,
 * the bond and the CFO decision are stored on the order row; the
 * delivered work (and, while the job runs, which stage is next and the
 * pages gathered so far) is stored in the deliveries table.
 *
 * No money moves here — escrow funding, x402 settlement and the Textile
 * swap happen in the agent runner (apps/agent), not in this form.
 */
import { z } from "zod";
import { Pool } from "pg";
import { JOB_TYPES, priceJob, type JobType } from "@ikenga/shared";
import {
  chainHash,
  MemoryLedger,
  PostgresLedger,
  type Ledger,
  type LedgerOrder,
  type StoredReportData,
} from "@ikenga/ledger";
import type { CreativeJobType, CreativeProgress, ReportProgress } from "@ikenga/agent";
import { creativeStageLabel, reportStageLabel } from "@ikenga/agent";

/** Plain-words label for what the team is doing right now, for any job type. */
export function deliveryStageLabel(jobType: JobType, stage: number): string {
  return jobType === "market-report" ? reportStageLabel(stage) : creativeStageLabel(stage, jobType as CreativeJobType);
}

export const HireInputSchema = z.object({
  jobType: z.enum(JOB_TYPES),
  description: z.string().min(1, "Describe the job").max(500),
  customerWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Enter a valid wallet address (0x…)"),
});
export type HireInput = z.infer<typeof HireInputSchema>;

/** Rough tool-cost estimates per job type (USDC). Labelled estimates. */
export const ESTIMATED_TOOL_COST_USDC: Record<JobType, number> = {
  website: 0.6,
  "promo-video": 1.4,
  flyers: 0.4,
  "market-report": 0.8,
};

export interface HireResult {
  id: string;
  jobType: JobType;
  description: string;
  customerWallet: string;
  status: "draft" | "in-progress" | "delivered" | "accepted" | "rejected" | "refunded";
  priceUsdc: number;
  bondUsdc: number;
  cfoAccepted: boolean;
  cfoReason: string;
  decisionHash: string;
  createdAt: string;
}

let ledgerSingleton: Ledger | null = null;
let ledgerInit: Promise<Ledger> | null = null;

/** The ledger backend for this server. Postgres when DATABASE_URL is set, memory otherwise. */
export function ledgerBackend(): "postgres" | "memory" {
  return process.env.DATABASE_URL ? "postgres" : "memory";
}

export async function getLedger(): Promise<Ledger> {
  if (ledgerSingleton) return ledgerSingleton;
  if (!ledgerInit) {
    ledgerInit = (async (): Promise<Ledger> => {
      if (process.env.DATABASE_URL) {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const pg = new PostgresLedger(pool as never);
        await pg.init();
        ledgerSingleton = pg;
      } else {
        ledgerSingleton = new MemoryLedger();
      }
      return ledgerSingleton;
    })();
  }
  return ledgerInit;
}

/** Test seam: replace the ledger (used by tests to isolate state). */
export function setLedgerForTests(ledger: Ledger): void {
  ledgerSingleton = ledger;
  ledgerInit = Promise.resolve(ledger);
}

function orderToHire(o: LedgerOrder): HireResult {
  return {
    id: o.id,
    jobType: o.jobType as JobType,
    description: o.description,
    customerWallet: o.customerWallet,
    status: o.status as HireResult["status"],
    priceUsdc: o.priceMicroUsdc / 1_000_000,
    bondUsdc: (o.bondMicroUsdc ?? 100_000) / 1_000_000,
    cfoAccepted: o.cfoAccepted ?? true,
    cfoReason: o.cfoReason ?? "",
    decisionHash: o.decisionHash ?? "",
    createdAt: o.createdAt,
  };
}

export async function listHires(): Promise<HireResult[]> {
  const ledger = await getLedger();
  return (await ledger.listOrders()).map(orderToHire);
}

export async function getHire(id: string): Promise<HireResult | null> {
  const ledger = await getLedger();
  const order = await ledger.getOrder(id);
  return order ? orderToHire(order) : null;
}

/** Change a hire's status (accept / reject) — only the paying wallet's job. */
export async function setHireStatus(id: string, status: HireResult["status"]): Promise<HireResult | null> {
  const ledger = await getLedger();
  const order = await ledger.updateOrderStatus(id, status);
  return order ? orderToHire(order) : null;
}

/** The delivered work for a job, once the team has done it. */
export type StoredReport = StoredReportData;

export async function getReport(id: string): Promise<StoredReport | null> {
  const ledger = await getLedger();
  return ledger.getReport(id);
}

export async function setReport(id: string, report: StoredReport): Promise<void> {
  const ledger = await getLedger();
  await ledger.saveReport(id, report);
}

/** A saved report as the staged runner's progress (the brief comes from the hire). */
export function reportToProgress(report: StoredReport, brief: string): ReportProgress {
  return {
    stage: report.stage,
    brief,
    revisionNote: report.revisionNote,
    pages: report.pages ?? [],
    plan: report.plan ?? "",
    report: report.report,
    checkText: report.checkText ?? "",
    // A stored report only ever carries report agents; the stored
    // shape widened to cover creative agents too.
    steps: report.steps as ReportProgress["steps"],
    sources: report.sources,
    totalTokens: report.totalTokens,
    totalCostUsd: report.totalCostUsd,
    revisions: report.revisions,
    status: report.status,
    reason: report.reason,
    deliveredAt: report.deliveredAt,
  };
}

/** The staged runner's progress as a saved report. */
export function progressToReport(progress: ReportProgress): StoredReport {
  return {
    report: progress.report,
    sources: progress.sources,
    steps: progress.steps,
    totalTokens: progress.totalTokens,
    totalCostUsd: progress.totalCostUsd,
    status: progress.status,
    reason: progress.reason,
    revisions: progress.revisions,
    deliveredAt: progress.deliveredAt,
    stage: progress.stage,
    pages: progress.pages,
    plan: progress.plan,
    checkText: progress.checkText,
    revisionNote: progress.revisionNote,
  };
}

/** A fresh, not-yet-started report for a hire. */
export function emptyStoredReport(): StoredReport {
  return {
    report: "",
    sources: [],
    steps: [],
    totalTokens: 0,
    totalCostUsd: 0,
    status: "in-progress",
    revisions: 0,
    deliveredAt: "",
    stage: 1,
    pages: [],
    plan: "",
    checkText: "",
  };
}

/** The creative job type behind a stored delivery, from the hire. */
export function deliverableKindFor(jobType: JobType): "report" | "website" | "flyer" | "slideshow" {
  return jobType === "market-report" ? "report" : jobType === "website" ? "website" : jobType === "flyers" ? "flyer" : "slideshow";
}

/** A fresh, not-yet-started creative delivery for a hire. */
export function emptyStoredCreative(jobType: JobType): StoredReport {
  return {
    report: "",
    sources: [],
    steps: [],
    totalTokens: 0,
    totalCostUsd: 0,
    status: "in-progress",
    revisions: 0,
    deliveredAt: "",
    stage: 1,
    checkText: "",
    deliverableKind: deliverableKindFor(jobType),
    html: "",
    slides: [],
  };
}

/** A saved creative delivery as the staged runner's progress (the brief comes from the hire). */
export function creativeToProgress(report: StoredReport, brief: string, jobType: CreativeJobType): CreativeProgress {
  return {
    stage: report.stage,
    jobType,
    brief,
    revisionNote: report.revisionNote,
    facts: report.facts ?? null,
    html: report.html ?? "",
    slides: report.slides ?? [],
    checkText: report.checkText ?? "",
    steps: (report.steps as CreativeProgress["steps"]) ?? [],
    totalTokens: report.totalTokens,
    totalCostUsd: report.totalCostUsd,
    revisions: report.revisions,
    status: report.status,
    reason: report.reason,
    deliveredAt: report.deliveredAt,
  };
}

/** The staged runner's progress as a saved creative delivery. */
export function progressToCreative(progress: CreativeProgress): StoredReport {
  return {
    report: "",
    sources: [],
    steps: progress.steps,
    totalTokens: progress.totalTokens,
    totalCostUsd: progress.totalCostUsd,
    status: progress.status,
    reason: progress.reason,
    revisions: progress.revisions,
    deliveredAt: progress.deliveredAt,
    stage: progress.stage,
    checkText: progress.checkText,
    revisionNote: progress.revisionNote,
    deliverableKind: deliverableKindFor(progress.jobType),
    html: progress.html,
    slides: progress.slides,
    facts: progress.facts ?? undefined,
  };
}

export async function createHire(input: HireInput): Promise<HireResult> {
  const parsed = HireInputSchema.parse(input);
  const quote = priceJob({
    jobType: parsed.jobType,
    toolCostUsdc: ESTIMATED_TOOL_COST_USDC[parsed.jobType],
    accepted: 0,
    quoted: 0,
  });
  const id = `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ledger = await getLedger();
  // The decision hash is known before the decision is appended: a new
  // order has an empty chain, so the first link hashes from the genesis
  // hash. Store it on the order row so the hire is complete in one write.
  const entry = `quote|${quote.reason}|${quote.priceUsdc * 1_000_000}`;
  const decisionHash = chainHash("0".repeat(64), entry);
  // The Postgres decision_log references orders(id) — create the order first.
  await ledger.createOrder({
    id,
    jobType: parsed.jobType,
    customerWallet: parsed.customerWallet,
    description: parsed.description,
    status: "draft",
    priceMicroUsdc: quote.priceUsdc * 1_000_000,
    bondMicroUsdc: Math.round(quote.bondUsdc * 1_000_000),
    cfoAccepted: quote.accepted,
    cfoReason: quote.reason,
    decisionHash,
  });
  const decision = await ledger.appendDecision({
    id: `dec_${id}`,
    orderId: id,
    kind: quote.accepted ? "quote" : "refuse",
    reason: quote.reason,
    amountMicroUsdc: quote.priceUsdc * 1_000_000,
    signature: "0xikenga-step2",
    entry,
  });
  const hire: HireResult = {
    id,
    jobType: parsed.jobType,
    description: parsed.description,
    customerWallet: parsed.customerWallet,
    status: "draft",
    priceUsdc: quote.priceUsdc,
    bondUsdc: quote.bondUsdc,
    cfoAccepted: quote.accepted,
    cfoReason: quote.reason,
    decisionHash: decision.hash,
    createdAt: new Date().toISOString(),
  };
  return hire;
}
