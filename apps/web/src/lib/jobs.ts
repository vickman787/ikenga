/**
 * Step 2 hire flow.
 *
 * The ledger is Postgres when DATABASE_URL is set (real schema, init on
 * first use), otherwise the in-memory MemoryLedger (dev/demo, lost on
 * restart). Either way the hire flow is honest: a $1 quote from the
 * deterministic CFO, recorded in the hash-chained ledger. No money moves
 * here — escrow funding, x402 settlement and the Textile swap happen in
 * the agent runner (apps/agent), not in this form.
 */
import { z } from "zod";
import { Pool } from "pg";
import { JOB_TYPES, priceJob, type JobType } from "@ikenga/shared";
import { MemoryLedger, PostgresLedger, type Ledger } from "@ikenga/ledger";

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
  status: "draft";
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

const orders: HireResult[] = [];

export function listHires(): HireResult[] {
  return [...orders];
}

export function getHire(id: string): HireResult | null {
  return orders.find((o) => o.id === id) ?? null;
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
  // The Postgres decision_log references orders(id) — create the order first.
  await ledger.createOrder({
    id,
    jobType: parsed.jobType,
    customerWallet: parsed.customerWallet,
    description: parsed.description,
    status: "draft",
  });
  const decision = await ledger.appendDecision({
    id: `dec_${id}`,
    orderId: id,
    kind: quote.accepted ? "quote" : "refuse",
    reason: quote.reason,
    amountMicroUsdc: quote.priceUsdc * 1_000_000,
    signature: "0xikenga-step2",
    entry: `quote|${quote.reason}|${quote.priceUsdc * 1_000_000}`,
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
  orders.push(hire);
  return hire;
}
