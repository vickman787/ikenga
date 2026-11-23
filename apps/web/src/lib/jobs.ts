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
import { creativeStageLabel, investigateJobEscrow, reportStageLabel, type InvestigatorResult } from "@ikenga/agent";
// Mainnet defaults, from the deployed contracts (contracts/deployments/celo.json).
// The Sepolia deployment file is local-only and gitignored, so Sepolia
// config must come from env — see getChainConfig().
import celoDeploy from "../../../../contracts/deployments/celo.json";

/** On-chain escrow checks, from @ikenga/payments (viem lives there —
// the web app has no viem dependency of its own). The routes import
// them from here. */
import { readEscrowDeliverableHash, readEscrowOnchain, readVaultOnchain, resolveAttributionTag, verifyTxReceipt } from "@ikenga/payments";
export { readEscrowDeliverableHash, readEscrowOnchain, readVaultOnchain, resolveAttributionTag, verifyTxReceipt };
import { resolveAttributionTag as resolveTag, TextileClient, TEXTILE_CELO_TOKENS, cngnJobPrice } from "@ikenga/payments";
import { IKENGA_AGENT_WALLET } from "./agentRegistration";
export type { EscrowOnchain, TxReceiptCheck } from "@ikenga/payments";

/** The currencies a $1 job can be paid in. USDT on mainnet, test USDC on Sepolia, cNGN on mainnet. */
export type PayCurrency = "USDT" | "USDC" | "cNGN";
/** Celo mainnet cNGN (6 decimals) — the token a cNGN job's escrow holds. */
export const CNGN_TOKEN_ADDRESS = TEXTILE_CELO_TOKENS.cNGN as string;

/**
 * Wallets that only ever belong to test runs: the Sepolia test wallet,
 * the agent wallet itself, and the 0x…0001 placeholder the live API
 * tests used as a dummy customer. No real customer can pay from these —
 * the first two are ours, and the third is an address nobody holds the
 * key for (address 1, a precompile).
 */
export const KNOWN_TEST_WALLETS: ReadonlySet<string> = new Set(
  [
    "0x94CcF19e6e12B64272D3b4946Dc34a9Ae9B74C50", // Sepolia test wallet
    IKENGA_AGENT_WALLET,
    "0x0000000000000000000000000000000000000001", // dummy customer in live API tests
  ].map((a) => a.toLowerCase()),
);

/** Celo mainnet tokens a real job can be paid in. A job whose stored
 * token is not one of these ran on another chain (Sepolia test USDC) —
 * a test run, even if its escrow was funded there. */
const MAINNET_JOB_TOKENS: ReadonlySet<string> = new Set(
  [celoDeploy.token.USDT, CNGN_TOKEN_ADDRESS].map((a) => a.toLowerCase()),
);

/**
 * Is this a real job — one a real customer paid for on Celo mainnet?
 * A test run fails at least one of these:
 * - it never had a funded escrow (the funding hash is only recorded
 *   after the server checks the payment onchain, so it proves real money);
 * - its customer wallet is one of ours (Sepolia test wallet, agent
 *   wallet, or the dummy placeholder from the live API tests);
 * - its stored token is not a Celo mainnet token (Sepolia test USDC).
 * Old rows store no token, so an empty token never excludes on its own
 * — the escrow and funding checks already prove those. The full log
 * keeps every job either way; this only decides what the headline
 * counts show. No job IDs are hardcoded here, so the next test run is
 * excluded by the same rule.
 */
export function isRealHire(h: {
  customerWallet: string;
  escrowAddress?: string | null;
  fundTxHash?: string | null;
  tokenAddress?: string | null;
}): boolean {
  if (!h.escrowAddress || !h.fundTxHash) return false;
  if (KNOWN_TEST_WALLETS.has(h.customerWallet.toLowerCase())) return false;
  const token = (h.tokenAddress ?? "").toLowerCase();
  if (token && !MAINNET_JOB_TOKENS.has(token)) return false;
  return true;
}

/** Only the real jobs — test runs stay in the log, out of the totals. */
export function realHires(hires: HireResult[]): HireResult[] {
  return hires.filter(isRealHire);
}

/**
 * Investigator's escrow check for a hire, wired to the real chain.
 * The team only starts a job whose escrow checks out onchain (see
 * investigator.ts for the checks — customer, token, vault, price,
 * funded state, balance). The caller records each check in the log
 * and refuses to start the job when one fails, or when the chain
 * cannot be read at all.
 */
export async function investigateHireEscrow(hire: HireResult): Promise<InvestigatorResult> {
  return investigateJobEscrow(
    {
      customerWallet: hire.customerWallet,
      escrowAddress: hire.escrowAddress ?? "",
      tokenAddress: hire.tokenAddress,
      vaultAddress: hire.vaultAddress,
      priceAtomic: hire.priceAtomic,
    },
    { readEscrow: (address) => readEscrowOnchain(address) },
  );
}

/** Plain-words label for what the team is doing right now, for any job type. */
export function deliveryStageLabel(jobType: JobType, stage: number): string {
  return jobType === "market-report" ? reportStageLabel(stage) : creativeStageLabel(stage, jobType as CreativeJobType);
}

export const HireInputSchema = z.object({
  jobType: z.enum(JOB_TYPES),
  description: z.string().min(1, "Describe the job").max(500),
  customerWallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Enter a valid wallet address (0x…)"),
  /** Which currency to pay the $1 in. USDT on mainnet, cNGN on mainnet,
   * test USDC on Sepolia. Defaults to the chain's own currency. */
  payCurrency: z.enum(["USDT", "USDC", "cNGN"]).optional(),
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
  /** Which currency this job is paid in, and the exact price fixed at
   * hire time in that currency's atomic units (6 decimals). USDT/USDC
   * jobs are always "1000000"; a cNGN job is the live-rate amount
   * (about "1445000000") with the rate it was fixed at. The customer
   * pays exactly priceAtomic — never a re-derived amount. */
  payCurrency: PayCurrency;
  priceAtomic: string;
  priceRate: string | null;
  tokenAddress: string;
  vaultAddress: string;
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

/** Which chain a job's escrow lives on, and what it pays with. The
 * single vaultAddress / tokenAddress / tokenSymbol / priceAtomic are
 * the chain's default currency (USDT on mainnet, test USDC on Sepolia)
 * for older callers; a job's own payment comes from its job record.
 * tokens / vaults / payTokens list every currency a job can be paid in
 * on this chain — mainnet has USDT and cNGN, each with its own vault;
 * Sepolia has test USDC only, because there is no cNGN on Sepolia. */
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
  /**
   * The agent wallet — the public address that holds the USDT for naira
   * bills and sends the cNGN to the supplier. Public onchain address, not
   * a secret. The bill page shows it when funding is needed.
   */
  agentWallet: string;
  /** Currencies a job can be paid in on this chain. */
  payTokens: PayCurrency[];
  /** Token address per currency (absent when the currency is not on this chain). */
  tokens: Partial<Record<PayCurrency, string>>;
  /** Vault address per currency (absent when the vault is not deployed yet). */
  vaults: Partial<Record<PayCurrency, string>>;
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
      agentWallet: IKENGA_AGENT_WALLET,
      payTokens: ["USDC"],
      tokens: { USDC: tokenAddress },
      vaults: { USDC: vaultAddress },
    };
  }
  const cngnVaultAddress =
    process.env.IKENGA_CNGN_VAULT_ADDRESS ?? (celoDeploy as { cngnVault?: string | null }).cngnVault ?? null;
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
    agentWallet: IKENGA_AGENT_WALLET,
    payTokens: ["USDT", "cNGN"],
    tokens: { USDT: process.env.IKENGA_TOKEN_ADDRESS ?? celoDeploy.token.USDT, cNGN: CNGN_TOKEN_ADDRESS },
    vaults: {
      USDT: process.env.IKENGA_VAULT_ADDRESS ?? celoDeploy.IkengaVault,
      ...(cngnVaultAddress ? { cNGN: cngnVaultAddress } : {}),
    },
  };
}

/**
 * The live cNGN price of $1, from a Textile FX preview: sell exactly $1
 * of USDT, read back how much cNGN comes out. Read-only, no key, no
 * signing. Throws in plain words when the rate can't be read — a job
 * must never be hired on a guessed price.
 */
export async function liveCngnUsdPreviewBuyAmount(): Promise<string> {
  let preview;
  try {
    preview = await new TextileClient().previewQuote({
      chainId: 42220,
      sellToken: TEXTILE_CELO_TOKENS.USDT as string,
      buyToken: CNGN_TOKEN_ADDRESS,
      sellAmount: "1000000",
    });
  } catch (err) {
    throw new Error(
      `Could not read the live naira rate right now — pay in USDT, or try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`,
    );
  }
  if (preview.kind === "no_quote") {
    throw new Error("No naira rate is available right now — pay in USDT, or try again in a moment.");
  }
  return preview.buyAmount;
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
  const payCurrency = (o.payCurrency ?? "USDT") as PayCurrency;
  return {
    id: o.id,
    jobType: o.jobType as JobType,
    description: o.description,
    customerWallet: o.customerWallet,
    status: o.status as HireResult["status"],
    priceUsdc: o.priceMicroUsdc / 1_000_000,
    bondUsdc: (o.bondMicroUsdc ?? 100_000) / 1_000_000,
    payCurrency,
    priceAtomic: o.priceAtomic ?? "1000000",
    priceRate: o.priceRate ?? null,
    tokenAddress: o.tokenAddress ?? "",
    vaultAddress: o.vaultAddress ?? "",
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
 * The landing page's real-work numbers, from the hires themselves —
 * real jobs only. Test runs we did while building are left out of the
 * totals (see isRealHire); they stay in the signed log. Done means
 * delivered or accepted; settled means accepted (the $1 is in the
 * vault). firstDoneJobId is the first finished job's page, so the
 * landing can link to a real job instead of inventing one.
 */
export function summarizeHires(hires: HireResult[]): {
  jobs: number;
  done: number;
  settled: number;
  /** Distinct paying wallets among finished jobs. */
  customers: number;
  firstDoneJobId: string | null;
  /** Test runs left out of the totals above — they stay in the log. */
  excludedTestJobs: number;
} {
  const real = realHires(hires);
  const done = real.filter((h) => h.status === "delivered" || h.status === "accepted");
  const firstDone = [...done].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return {
    jobs: real.length,
    done: done.length,
    settled: real.filter((h) => h.status === "accepted").length,
    customers: new Set(done.map((h) => h.customerWallet.toLowerCase())).size,
    firstDoneJobId: firstDone ? firstDone.id : null,
    excludedTestJobs: hires.length - real.length,
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
    candidates: report.candidates ?? [],
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
    candidates: progress.candidates,
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

/**
 * Test seam: replace the live cNGN preview with a fixed buy amount
 * (atomic cNGN for selling $1 of USDT). Live runs always read the real
 * rate; tests must never depend on it.
 */
export interface CreateHireDeps {
  previewCngnUsd?: () => Promise<string>;
}

export async function createHire(input: HireInput, deps: CreateHireDeps = {}): Promise<HireResult> {
  const parsed = HireInputSchema.parse(input);
  const config = getChainConfig();
  // The currency defaults to the chain's own: USDT on mainnet, test
  // USDC on Sepolia. Anything else must be offered on this chain.
  const currency = (parsed.payCurrency ?? config.tokenSymbol) as PayCurrency;
  if (!config.payTokens.includes(currency)) {
    throw new Error(
      `${currency} isn't a way to pay on ${config.chainName} — pay in ${config.tokenSymbol} here.`,
    );
  }
  const tokenAddress = config.tokens[currency];
  const vaultAddress = config.vaults[currency];
  if (!tokenAddress || !vaultAddress) {
    throw new Error(
      `${currency} payments aren't switched on yet — pay in ${config.tokenSymbol} for now.`,
    );
  }
  // The price is fixed NOW, at hire time, and stored on the job: USDT
  // is always $1 (1,000,000 atomic); cNGN is the live rate, rounded up
  // to whole naira. A later rate move never changes a hired job's price.
  let priceAtomic = "1000000";
  let priceRate: string | null = null;
  if (currency === "cNGN") {
    const buyAmount = await (deps.previewCngnUsd?.() ?? liveCngnUsdPreviewBuyAmount());
    const fixed = cngnJobPrice(buyAmount);
    priceAtomic = fixed.priceAtomic.toString();
    priceRate = fixed.rateCngnPerUsd;
  }
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
  // The entry names the currency, so the log says what was actually paid.
  const entry = `quote|${currency}|${quote.reason}|${priceAtomic}`;
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
    payCurrency: currency,
    priceAtomic,
    priceRate,
    tokenAddress,
    vaultAddress,
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
    currency,
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
    payCurrency: currency,
    priceAtomic,
    priceRate,
    tokenAddress,
    vaultAddress,
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
