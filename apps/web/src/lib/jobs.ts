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
 * The $1 itself moves through escrow, not through this form. Each job
 * gets its own JobEscrow contract, deployed from the customer's browser:
 * the browser posts the escrow address here, then pays the $1 in, and
 * only once the server has checked that payment onchain does the team
 * start. Accepting the work releases the $1 to the vault; turning it
 * down sends it back. The on-chain checks live in @ikenga/payments
 * (readEscrowOnchain / verifyTxReceipt, re-exported below) and the
 * routes under app/api/jobs/[id]/.
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
// Mainnet defaults, from the deployed contracts (contracts/deployments/celo.json).
// The Sepolia deployment file is local-only and gitignored, so Sepolia
// config must come from env — see getChainConfig().
import celoDeploy from "../../../../contracts/deployments/celo.json";

/** On-chain escrow checks, from @ikenga/payments (viem lives there —
// the web app has no viem dependency of its own). The routes import
// them from here. */
export { readEscrowDeliverableHash, readEscrowOnchain, readVaultOnchain, resolveAttributionTag, verifyTxReceipt } from "@ikenga/payments";
import { resolveAttributionTag as resolveTag } from "@ikenga/payments";
export type { EscrowOnchain, TxReceiptCheck } from "@ikenga/payments";

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
  status: "draft" | "escrowed" | "in-progress" | "delivered" | "accepted" | "rejected" | "refunded";
  priceUsdc: number;
  bondUsdc: number;
  cfoAccepted: boolean;
  cfoReason: string;
  decisionHash: string;
  createdAt: string;
  /** The job's own JobEscrow contract. Null until the browser deploys and registers it. */
  escrowAddress: string | null;
  /** Tx that paid the $1 into the escrow. Null until funded. */
  fundTxHash: string | null;
  /** Tx that sealed the delivered work's hash on the escrow. Null until sealed (boss worker). */
  deliverableTxHash: string | null;
  /** Tx that settled the escrow — the customer's accept() or reject(). Null until decided. */
  settleTxHash: string | null;
  /** The escrow's on-chain state, read off the job's status. Null until an escrow is registered. */
  escrowState: "unfunded" | "funded" | "accepted" | "rejected" | "released" | null;
}

/** Which chain a job's escrow lives on, and what it pays with. */
export interface ChainConfig {
  chainId: number;
  chainName: string;
  vaultAddress: string;
  tokenAddress: string;
  tokenSymbol: "USDT" | "USDC";
  /** The $1 price in atomic units (6 decimals), as a string. */
  priceAtomic: "1000000";
  /** The bond in atomic units — always "0" (see createHire). */
  bondAtomic: "0";
  explorerUrl: string;
  /**
   * The ERC-8021 attribution tag the browser sticks on the customer's own
   * transactions (deploy, approve, fund, accept, reject) so the tracker
   * counts the payment itself, not just the boss's seal. Public code, not
   * a secret. Null when no tag is configured — the payment still goes
   * through untagged rather than blocking the job.
   */
  attributionTag: string | null;
}

/**
 * The chain the escrows live on. IKENGA_CHAIN picks it ("mainnet" by
 * default, "sepolia" for tests); IKENGA_VAULT_ADDRESS and
 * IKENGA_TOKEN_ADDRESS override the addresses. Mainnet defaults come
 * from contracts/deployments/celo.json; Sepolia has no shipped defaults
 * (its deployment file is local-only), so Sepolia without both env vars
 * is an error, not a guess.
 */
export function getChainConfig(): ChainConfig {
  const chain = (process.env.IKENGA_CHAIN ?? "mainnet").toLowerCase();
  if (chain !== "mainnet" && chain !== "sepolia") {
    throw new Error(`IKENGA_CHAIN must be "mainnet" or "sepolia", got "${chain}".`);
  }
  if (chain === "sepolia") {
    const vaultAddress = process.env.IKENGA_VAULT_ADDRESS;
    const tokenAddress = process.env.IKENGA_TOKEN_ADDRESS;
    if (!vaultAddress || !tokenAddress) {
      throw new Error(
        "Sepolia needs IKENGA_VAULT_ADDRESS and IKENGA_TOKEN_ADDRESS set on the server — the Sepolia deployment file is local-only and never ships.",
      );
    }
    return {
      chainId: 11142220,
      chainName: "Celo Sepolia",
      vaultAddress,
      tokenAddress,
      tokenSymbol: "USDC",
      priceAtomic: "1000000",
      bondAtomic: "0",
      explorerUrl: "https://celo-sepolia.blockscout.com",
      attributionTag: chainAttributionTag(),
    };
  }
  return {
    chainId: 42220,
    chainName: "Celo",
    vaultAddress: process.env.IKENGA_VAULT_ADDRESS ?? celoDeploy.IkengaVault,
    tokenAddress: process.env.IKENGA_TOKEN_ADDRESS ?? celoDeploy.token.USDT,
    tokenSymbol: "USDT",
    priceAtomic: "1000000",
    bondAtomic: "0",
    explorerUrl: "https://celoscan.io",
    attributionTag: chainAttributionTag(),
  };
}

/**
 * The attribution tag for /api/chain, or null when none is configured.
 * Never throws — a missing tag must not break the chain config (and the
 * hire flow with it); the browser then sends the payment untagged.
 */
function chainAttributionTag(): string | null {
  const tag = process.env.IKENGA_ATTRIBUTION_TAG;
  if (!tag) return null;
  try {
    return resolveTag(tag);
  } catch {
    return null;
  }
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
        // Supabase's pooler presents a cert chain Node's default trust store
        // rejects ("self-signed certificate in certificate chain"). pg's
        // ConnectionParameters does Object.assign(config, parse(url)), so a
        // sslmode=require in the URL overwrites any ssl object passed in
        // code — passing ssl:{rejectUnauthorized:false} alone does NOT work
        // (verified: it normalises to ssl={} and still verifies). So strip
        // sslmode out of the URL and pass the ssl option explicitly. The
        // pooler is still encrypted; we just don't verify its CA. Local
        // Postgres URLs carry no sslmode and stay untouched.
        const dbUrl = new URL(process.env.DATABASE_URL);
        const sslMode = dbUrl.searchParams.get("sslmode");
        dbUrl.searchParams.delete("sslmode");
        const pool = new Pool({
          connectionString: dbUrl.toString(),
          ...(sslMode && sslMode !== "disable"
            ? { ssl: { rejectUnauthorized: false } }
            : {}),
        });
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

/** The escrow's on-chain state, read off the job's status. "released"
 * (the 48h deadline release) has no job status of its own — the server
 * never drives it — so it never comes out of this mapping yet. */
function escrowStateFor(o: LedgerOrder): HireResult["escrowState"] {
  if (!o.escrowAddress) return null;
  if (o.status === "accepted") return "accepted";
  if (o.status === "refunded" || o.status === "rejected") return "rejected";
  if (o.status === "draft") return "unfunded";
  return "funded"; // escrowed, in-progress, delivered
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
    escrowAddress: o.escrowAddress ?? null,
    fundTxHash: o.fundTxHash ?? null,
    deliverableTxHash: o.deliverableTxHash ?? null,
    settleTxHash: o.settleTxHash ?? null,
    escrowState: escrowStateFor(o),
  };
}

export async function listHires(): Promise<HireResult[]> {
  const ledger = await getLedger();
  return (await ledger.listOrders()).map(orderToHire);
}

/**
 * The landing page's real-work numbers, from the hires themselves.
 * Done means delivered or accepted; settled means accepted (the $1 is
 * in the vault). firstDoneJobId is the first finished job's page, so
 * the landing can link to a real job instead of inventing one.
 */
export function summarizeHires(hires: HireResult[]): {
  jobs: number;
  done: number;
  settled: number;
  /** Distinct paying wallets among finished jobs. */
  customers: number;
  firstDoneJobId: string | null;
} {
  const done = hires.filter((h) => h.status === "delivered" || h.status === "accepted");
  const firstDone = [...done].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return {
    jobs: hires.length,
    done: done.length,
    settled: hires.filter((h) => h.status === "accepted").length,
    customers: new Set(done.map((h) => h.customerWallet.toLowerCase())).size,
    firstDoneJobId: firstDone ? firstDone.id : null,
  };
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
    auditFacts: report.auditFacts ?? "",
    auditFinal: report.auditFinal ?? "",
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
    auditFacts: progress.auditFacts,
    auditFinal: progress.auditFinal,
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
    auditFacts: "",
    auditFinal: "",
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
    // Bond is 0, always: the vault's BOND bucket holds no USDT, and
    // JobEscrow.reject() with a bond above 0 and no locked bond REVERTS
    // (it calls vault.payBond, which needs a locked bond) — so a bond
    // would make refunds impossible. The CFO's priceJob still computes
    // a bond for its expected-profit maths; it is not put up on-chain.
    bondMicroUsdc: 0,
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
    bondUsdc: 0,
    cfoAccepted: quote.accepted,
    cfoReason: quote.reason,
    decisionHash: decision.hash,
    createdAt: new Date().toISOString(),
    escrowAddress: null,
    fundTxHash: null,
    deliverableTxHash: null,
    settleTxHash: null,
    escrowState: null,
  };
  return hire;
}
