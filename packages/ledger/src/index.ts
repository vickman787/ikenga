/**
 * @ikenga/ledger — the audit ledger.
 *
 * Every CFO decision is appended to a hash chain: each entry's hash covers
 * the previous entry's hash, so rewriting history breaks verification.
 * Money is integer micro-USDC (6 decimals) everywhere — never floats.
 *
 * Step 1 ships a MemoryLedger (dev/demo) and a PostgresLedger (real schema).
 * Neither moves money; they only record decisions.
 */
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export function chainHash(prevHash: string, entry: string): string {
  return createHash("sha256").update(`${prevHash}:${entry}`).digest("hex");
}

/** Recompute a chain of hashes; returns false if any link is broken. */
export function verifyChain(entries: { prevHash: string; hash: string; entry: string }[]): boolean {
  let prev = "0".repeat(64);
  for (const e of entries) {
    if (e.prevHash !== prev) return false;
    if (chainHash(prev, e.entry) !== e.hash) return false;
    prev = e.hash;
  }
  return true;
}

export interface LedgerOrder {
  id: string;
  jobType: string;
  customerWallet: string;
  description: string;
  status: string;
  priceMicroUsdc: number;
  /** Which currency the customer pays this job in. USDT on mainnet, test
   * USDC on Sepolia, cNGN on mainnet. The $1 value never changes — only
   * the currency it is paid in. Defaults to "USDT" for old rows. */
  payCurrency?: "USDT" | "USDC" | "cNGN";
  /** The exact price fixed at hire time, in the pay currency's atomic
   * units (6 decimals), as a string. "1000000" for a $1 USDT job; the
   * live-rate cNGN amount (about "1445000000") for a cNGN job. */
  priceAtomic?: string;
  /** cNGN per $1 fixed at hire time (e.g. "1444.067"). Null for USDT/USDC jobs. */
  priceRate?: string | null;
  /** The token the job's escrow holds. Null for old rows (USDT mainnet). */
  tokenAddress?: string | null;
  /** The vault the job's escrow pays into. Null for old rows (USDT vault). */
  vaultAddress?: string | null;
  /** Bond the CFO puts up (micro-USDC). Defaults to 100000 ($0.10) for old rows. */
  bondMicroUsdc?: number;
  cfoAccepted?: boolean;
  cfoReason?: string;
  decisionHash?: string;
  /** The job's own JobEscrow contract, deployed from the customer's browser. Null until the escrow is registered. */
  escrowAddress?: string | null;
  /** Tx that paid the $1 into the escrow (fund()). */
  fundTxHash?: string | null;
  /** Tx that sealed the delivered work's hash on the escrow (submitDeliverable(), via the vault). */
  deliverableTxHash?: string | null;
  /** Tx that settled the escrow — the customer's accept() or reject(). */
  settleTxHash?: string | null;
  createdAt: string;
}

/** The delivered work for a job, plus — while it is running — the stage
 * state the next chunked step needs to pick up where the last one stopped.
 * Stored as one JSON document in the deliveries table (and in memory for
 * the MemoryLedger). `stage` is the next stage to run; 0 means finished. */
export interface StoredReportData {
  generatorVersion?: 1 | 2;
  researchPlan?: { subjects: string[]; questions: string[]; queries: string[] };
  searchCursor?: number;
  readCursor?: number;
  report: string;
  sources: { title: string; url: string; retrievedAt?: string }[];
  steps: { agent: "Scout" | "Reader" | "Researcher" | "Writer" | "Analyst" | "Auditor" | "Designer" | "Producer" | "Messenger"; what: string; detail: string; model?: string; tokens?: number; costUsd?: number }[];
  totalTokens: number;
  totalCostUsd: number;
  status: "delivered" | "refused" | "in-progress";
  reason?: string;
  revisions: number;
  deliveredAt: string;
  stage: number;
  /** Pages Scout read (kept so later stages — and a revision — reuse them). */
  pages?: { title: string; url: string; text: string; retrievedAt?: string }[];
  /** Candidate pages Scout found, waiting for Reader to read them
   * (kept so the chunked run survives between stages). */
  candidates?: { title: string; url: string }[];
  plan?: string;
  checkText?: string;
  revisionNote?: string;
  /** What the facts read-through said (market report). */
  auditFacts?: string;
  /** What the final read said (market report). */
  auditFinal?: string;
  /** What kind of work this delivery is (a market report keeps "report"). */
  deliverableKind?: "report" | "website" | "flyer" | "slideshow";
  /** The generated website / flyer page (sanitised HTML). Empty for a slideshow. */
  html?: string;
  /** The job's one picture, as a data URI — null when the job has none.
   * The picture is also embedded in the HTML / first slide; this field
   * is what the chunked runner reads back so a revision reuses it
   * instead of making a second one. */
  image?: string | null;
  /** The promo slideshow: one card per slide. Empty for a website / flyer. */
  slides?: { title: string; text: string; image?: string }[];
  /** Facts Designer / Producer read out of the brief (creative jobs). */
  facts?: {
    businessName: string;
    whatItDoes: string;
    services: string[];
    prices: { item: string; price: string; listed: boolean }[];
    contact: string;
    colours: string;
    notes: string;
  };
}

export interface LedgerDecision {
  id: string;
  orderId: string;
  kind: string;
  reason: string;
  amountMicroUsdc: number;
  /** Which currency the money in this decision is in. The amount is
   * still recorded in micro-USDC for the CFO's $1 maths; the currency
   * says what the customer actually paid. Defaults to "USDT" for old rows. */
  currency?: "USDT" | "USDC" | "cNGN";
  prevHash: string;
  hash: string;
  signature: string;
  createdAt: string;
  /** Full entry text the hash covers (Step 2 — stored, not recomputed). */
  entryText?: string;
  /** On-chain tx hash for this decision, if it has one. No hash = not settled. */
  txHash?: string | null;
}

export interface FxSwapRecord {
  rfqId: string;
  orderId: string;
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  takerPays: string;
  feeAmount: string;
  rateRay: string;
  expiresAt: string;
  orderDeadline: string;
  reactor: string;
  approvalTxHash?: string | null;
  swapTxHash?: string | null;
  forced?: boolean;
  status: "quoted" | "submitted" | "filled" | "no_quote" | "expired" | "failed";
}

export interface SelfVerificationRecord {
  id: string;
  agentId: string | null;
  agentAddress: string;
  verified: boolean;
  reason: string;
  expiresAt?: string | null;
  checkedAt: string;
}

export interface X402PaymentRecord {
  id: string;
  orderId: string;
  agentId?: string | null;
  asset: string;
  amountAtomic: string;
  payTo: string;
  txHash?: string | null;
  status: "verified" | "settled" | "failed" | "ambiguous";
}

export interface Reconciliation {
  orderId: string;
  /** x402 payments with a tx hash. A hash is necessary, not proof of confirmation — see plan §2.5. */
  settled: number;
  /** x402 payments with no tx hash. */
  unresolved: number;
  /** Failed or ambiguous payments. */
  failed: number;
}

/** A naira bill: one person owes a supplier in naira, and Ikenga changes
 * USDT to cNGN on Textile FX and pays the supplier in cNGN. The bill is
 * the Corridors-track job: it is NOT a $1 job and it has no escrow — the
 * agent wallet holds the USDT, swaps it, and pays cNGN straight to the
 * supplier's wallet. Amounts are whole naira; rates are cNGN per 1 USDT. */
export type BillStatus = "created" | "watching" | "converting" | "paid" | "failed";
export type BillDecision = "convert" | "refuse" | "force-convert" | "wait";

export interface LedgerBill {
  id: string;
  payerName: string;
  purpose: string;
  /** Whole naira the supplier is owed (e.g. 1500 = ₦1,500). Minimum 1500 — about $1, the corridor floor. */
  amountNgn: number;
  supplierWallet: string;
  deadline: string;
  /** Lowest rate the payer will accept, cNGN per 1 USDT. */
  minRate: number;
  status: BillStatus;
  /** Plain-words note on where the bill stands (funding needed, rate too low, …). Null until checked. */
  note: string | null;
  lastCheckedAt: string | null;
  /** Latest rate seen (cNGN per USDT, fee included — buyAmount / takerPays). */
  lastRate: number | null;
  lastRateAt: string | null;
  lastDecision: BillDecision | null;
  lastDecisionReason: string | null;
  lastBpsGap: number | null;
  /** Naira a refusal saved vs converting at the rate seen (whole cNGN). */
  lastNairaSaved: number | null;
  /** USDT the agent wallet needs to hold to pay this bill (from the preview's takerPays). */
  fundingNeededUsdt: string | null;
  /** Null = not checked yet. */
  fundingReady: boolean | null;
  /** The wallet that paid for this bill — the friend's own wallet, set by the first verified funding transfer. */
  fundingPayerWallet: string | null;
  /** Verified funding transfers for this bill. A hash is recorded on one bill only, so two bills can never claim the same funding. */
  fundingTxHashes: string[];
  /** Total USDT paid for this bill across its verified funding transfers, in atomic units (6 decimals). Null until the first funding lands. */
  fundingPaidUsdtAtomic: string | null;
  /** The firm quote being worked, if any. */
  rfqId: string | null;
  /** Tagged USDT approval tx(s) before the swap. */
  approvalTxHashes: string[];
  /** The swap itself. Carries Textile's tag, never Ikenga's — see textile.ts (risk R-5). */
  swapTxHash: string | null;
  /** True when the swap went ahead at the deadline below the minimum rate. */
  forced: boolean;
  /** The tagged cNGN payout to the supplier — the transaction that carries Ikenga's tag. */
  payoutTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One receipt in a bill's hash chain — the same chaining as the CFO
 * decision log, so a bill's history can't be rewritten silently. */
export type BillEventKind = "created" | "quote" | "refuse" | "convert" | "swap" | "payout" | "paid" | "failed" | "waiting" | "funded" | "checked";

export interface BillEvent {
  id: string;
  billId: string;
  kind: BillEventKind;
  reason: string;
  rateSeen: number | null;
  bpsGap: number | null;
  txHash: string | null;
  prevHash: string;
  hash: string;
  entryText?: string;
  createdAt: string;
}

/** Fields the boss worker may change on a bill. Only the fields present change. */
export interface BillPatch {
  status?: BillStatus;
  note?: string | null;
  lastCheckedAt?: string;
  lastRate?: number | null;
  lastRateAt?: string | null;
  lastDecision?: BillDecision | null;
  lastDecisionReason?: string | null;
  lastBpsGap?: number | null;
  lastNairaSaved?: number | null;
  fundingNeededUsdt?: string | null;
  fundingReady?: boolean | null;
  fundingPayerWallet?: string | null;
  fundingTxHashes?: string[];
  fundingPaidUsdtAtomic?: string | null;
  rfqId?: string | null;
  approvalTxHashes?: string[];
  swapTxHash?: string | null;
  forced?: boolean;
  payoutTxHash?: string | null;
}

export interface Ledger {
  createOrder(order: Omit<LedgerOrder, "createdAt" | "priceMicroUsdc"> & { priceMicroUsdc?: number }): Promise<LedgerOrder>;
  getOrder(id: string): Promise<LedgerOrder | null>;
  listOrders(): Promise<LedgerOrder[]>;
  /** Change an order's status (accept / reject / in-progress / delivered). */
  updateOrderStatus(id: string, status: string): Promise<LedgerOrder | null>;
  /** Record escrow fields on an order (address and tx hashes). Only the
   * fields present in the patch change; the rest are left alone. */
  updateOrderEscrow(id: string, patch: { escrowAddress?: string; fundTxHash?: string; deliverableTxHash?: string; settleTxHash?: string }): Promise<LedgerOrder | null>;
  /** Save the delivered work (or the in-progress report state) for an order. */
  saveReport(orderId: string, report: StoredReportData): Promise<StoredReportData>;
  /** Read it back; null when nothing has been delivered or started yet. */
  getReport(orderId: string): Promise<StoredReportData | null>;
  appendDecision(d: Omit<LedgerDecision, "prevHash" | "hash" | "createdAt"> & { entry: string }): Promise<LedgerDecision>;
  listDecisions(orderId: string): Promise<LedgerDecision[]>;
  /** Verify the hash chain for one order. True when the chain is intact. */
  verifyOrderChain(orderId: string): Promise<boolean>;
  /** Record an FX swap (claim token is never stored — server memory only). */
  recordFxSwap(swap: FxSwapRecord): Promise<FxSwapRecord>;
  listFxSwaps(orderId: string): Promise<FxSwapRecord[]>;
  /** Record a Self verification check. Never stores a nullifier. */
  recordSelfVerification(v: SelfVerificationRecord): Promise<SelfVerificationRecord>;
  /** Record an x402 payment. Settled only with a tx hash. */
  recordX402Payment(p: X402PaymentRecord): Promise<X402PaymentRecord>;
  /** Reconcile an order's payments: settled = tx hash present, unresolved = none, failed = failed/ambiguous. */
  reconcile(orderId: string): Promise<Reconciliation>;
  /** A naira bill (Corridors track): someone owes a supplier in naira. */
  createBill(bill: Omit<LedgerBill, "status" | "note" | "lastCheckedAt" | "lastRate" | "lastRateAt" | "lastDecision" | "lastDecisionReason" | "lastBpsGap" | "lastNairaSaved" | "fundingNeededUsdt" | "fundingReady" | "fundingPayerWallet" | "fundingTxHashes" | "fundingPaidUsdtAtomic" | "rfqId" | "approvalTxHashes" | "swapTxHash" | "forced" | "payoutTxHash" | "createdAt" | "updatedAt">): Promise<LedgerBill>;
  getBill(id: string): Promise<LedgerBill | null>;
  listBills(): Promise<LedgerBill[]>;
  /** Change a bill's fields (boss worker progress). Only the fields present change. */
  updateBill(id: string, patch: BillPatch): Promise<LedgerBill | null>;
  /** Append one receipt to a bill's hash chain. */
  appendBillEvent(e: Omit<BillEvent, "prevHash" | "hash" | "createdAt"> & { entry: string }): Promise<BillEvent>;
  listBillEvents(billId: string): Promise<BillEvent[]>;
  /** Verify the hash chain for one bill. True when the chain is intact. */
  verifyBillChain(billId: string): Promise<boolean>;
}

export class MemoryLedger implements Ledger {
  private orders = new Map<string, LedgerOrder>();
  private decisions = new Map<string, LedgerDecision[]>();
  private fxSwaps = new Map<string, FxSwapRecord[]>();
  private selfVerifications: SelfVerificationRecord[] = [];
  private x402Payments = new Map<string, X402PaymentRecord[]>();
  private reports = new Map<string, StoredReportData>();
  private bills = new Map<string, LedgerBill>();
  private billEvents = new Map<string, BillEvent[]>();

  async createOrder(order: Omit<LedgerOrder, "createdAt" | "priceMicroUsdc"> & { priceMicroUsdc?: number }): Promise<LedgerOrder> {
    const full: LedgerOrder = {
      ...order,
      priceMicroUsdc: order.priceMicroUsdc ?? 1_000_000,
      createdAt: new Date().toISOString(),
    };
    this.orders.set(full.id, full);
    return full;
  }

  async getOrder(id: string): Promise<LedgerOrder | null> {
    return this.orders.get(id) ?? null;
  }

  async listOrders(): Promise<LedgerOrder[]> {
    return [...this.orders.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateOrderStatus(id: string, status: string): Promise<LedgerOrder | null> {
    const order = this.orders.get(id);
    if (!order) return null;
    order.status = status;
    return order;
  }

  async updateOrderEscrow(
    id: string,
    patch: { escrowAddress?: string; fundTxHash?: string; deliverableTxHash?: string; settleTxHash?: string },
  ): Promise<LedgerOrder | null> {
    const order = this.orders.get(id);
    if (!order) return null;
    if (patch.escrowAddress !== undefined) order.escrowAddress = patch.escrowAddress;
    if (patch.fundTxHash !== undefined) order.fundTxHash = patch.fundTxHash;
    if (patch.deliverableTxHash !== undefined) order.deliverableTxHash = patch.deliverableTxHash;
    if (patch.settleTxHash !== undefined) order.settleTxHash = patch.settleTxHash;
    return order;
  }

  async saveReport(orderId: string, report: StoredReportData): Promise<StoredReportData> {
    this.reports.set(orderId, report);
    return report;
  }

  async getReport(orderId: string): Promise<StoredReportData | null> {
    return this.reports.get(orderId) ?? null;
  }

  async appendDecision(d: Omit<LedgerDecision, "prevHash" | "hash" | "createdAt"> & { entry: string }): Promise<LedgerDecision> {
    const list = this.decisions.get(d.orderId) ?? [];
    const prevHash = list.length === 0 ? "0".repeat(64) : list[list.length - 1].hash;
    const full: LedgerDecision = {
      ...d,
      prevHash,
      hash: chainHash(prevHash, d.entry),
      entryText: d.entry,
      txHash: d.txHash ?? null,
      createdAt: new Date().toISOString(),
    };
    list.push(full);
    this.decisions.set(d.orderId, list);
    return full;
  }

  async listDecisions(orderId: string): Promise<LedgerDecision[]> {
    return [...(this.decisions.get(orderId) ?? [])];
  }

  async verifyOrderChain(orderId: string): Promise<boolean> {
    const list = this.decisions.get(orderId) ?? [];
    // Step 2: verify from the stored entry text, not a recomputation from fields.
    return verifyChain(
      list.map((e) => ({ prevHash: e.prevHash, hash: e.hash, entry: e.entryText ?? `${e.kind}|${e.reason}|${e.amountMicroUsdc}` })),
    );
  }

  async recordFxSwap(swap: FxSwapRecord): Promise<FxSwapRecord> {
    const list = this.fxSwaps.get(swap.orderId) ?? [];
    list.push(swap);
    this.fxSwaps.set(swap.orderId, list);
    return swap;
  }

  async listFxSwaps(orderId: string): Promise<FxSwapRecord[]> {
    return [...(this.fxSwaps.get(orderId) ?? [])];
  }

  async recordSelfVerification(v: SelfVerificationRecord): Promise<SelfVerificationRecord> {
    this.selfVerifications.push(v);
    return v;
  }

  async recordX402Payment(p: X402PaymentRecord): Promise<X402PaymentRecord> {
    const list = this.x402Payments.get(p.orderId) ?? [];
    list.push(p);
    this.x402Payments.set(p.orderId, list);
    return p;
  }

  async reconcile(orderId: string): Promise<Reconciliation> {
    const payments = this.x402Payments.get(orderId) ?? [];
    return {
      orderId,
      settled: payments.filter((p) => p.status === "settled" && p.txHash).length,
      unresolved: payments.filter((p) => p.status === "verified" && !p.txHash).length,
      failed: payments.filter((p) => p.status === "failed" || p.status === "ambiguous").length,
    };
  }

  async createBill(
    bill: Omit<LedgerBill, "status" | "note" | "lastCheckedAt" | "lastRate" | "lastRateAt" | "lastDecision" | "lastDecisionReason" | "lastBpsGap" | "lastNairaSaved" | "fundingNeededUsdt" | "fundingReady" | "fundingPayerWallet" | "fundingTxHashes" | "fundingPaidUsdtAtomic" | "rfqId" | "approvalTxHashes" | "swapTxHash" | "forced" | "payoutTxHash" | "createdAt" | "updatedAt">,
  ): Promise<LedgerBill> {
    const now = new Date().toISOString();
    const full: LedgerBill = {
      ...bill,
      status: "created",
      note: null,
      lastCheckedAt: null,
      lastRate: null,
      lastRateAt: null,
      lastDecision: null,
      lastDecisionReason: null,
      lastBpsGap: null,
      lastNairaSaved: null,
      fundingNeededUsdt: null,
      fundingReady: null,
      fundingPayerWallet: null,
      fundingTxHashes: [],
      fundingPaidUsdtAtomic: null,
      rfqId: null,
      approvalTxHashes: [],
      swapTxHash: null,
      forced: false,
      payoutTxHash: null,
      createdAt: now,
      updatedAt: now,
    };
    this.bills.set(full.id, full);
    return full;
  }

  async getBill(id: string): Promise<LedgerBill | null> {
    return this.bills.get(id) ?? null;
  }

  async listBills(): Promise<LedgerBill[]> {
    return [...this.bills.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateBill(id: string, patch: BillPatch): Promise<LedgerBill | null> {
    const bill = this.bills.get(id);
    if (!bill) return null;
    Object.assign(bill, patch, { updatedAt: new Date().toISOString() });
    return bill;
  }

  async appendBillEvent(e: Omit<BillEvent, "prevHash" | "hash" | "createdAt"> & { entry: string }): Promise<BillEvent> {
    const list = this.billEvents.get(e.billId) ?? [];
    const prevHash = list.length === 0 ? "0".repeat(64) : list[list.length - 1].hash;
    const full: BillEvent = {
      ...e,
      prevHash,
      hash: chainHash(prevHash, e.entry),
      entryText: e.entry,
      rateSeen: e.rateSeen ?? null,
      bpsGap: e.bpsGap ?? null,
      txHash: e.txHash ?? null,
      createdAt: new Date().toISOString(),
    };
    list.push(full);
    this.billEvents.set(e.billId, list);
    return full;
  }

  async listBillEvents(billId: string): Promise<BillEvent[]> {
    return [...(this.billEvents.get(billId) ?? [])];
  }

  async verifyBillChain(billId: string): Promise<boolean> {
    const list = this.billEvents.get(billId) ?? [];
    return verifyChain(
      list.map((e) => ({ prevHash: e.prevHash, hash: e.hash, entry: e.entryText ?? `${e.kind}|${e.reason}` })),
    );
  }
}

export function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "schema.sql"), "utf8");
}

/** Postgres-backed ledger. Step 1: schema + append/read; reconciliation is Step 2+. */
export class PostgresLedger implements Ledger {
  constructor(private pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(loadSchemaSql());
  }

  async createOrder(order: Omit<LedgerOrder, "createdAt" | "priceMicroUsdc"> & { priceMicroUsdc?: number }): Promise<LedgerOrder> {
    const { rows } = await this.pool.query(
      `INSERT INTO orders (id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash, escrow_address, fund_tx_hash, deliverable_tx_hash, settle_tx_hash, pay_currency, price_atomic, price_rate, token_address, vault_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING ${ORDER_COLS}`,
      [order.id, order.jobType, order.customerWallet, order.description, order.status, order.priceMicroUsdc ?? 1_000_000,
       order.bondMicroUsdc ?? 100_000, order.cfoAccepted ?? true, order.cfoReason ?? "", order.decisionHash ?? "",
       order.escrowAddress ?? null, order.fundTxHash ?? null, order.deliverableTxHash ?? null, order.settleTxHash ?? null,
       order.payCurrency ?? "USDT", order.priceAtomic ?? "1000000", order.priceRate ?? null,
       order.tokenAddress ?? null, order.vaultAddress ?? null],
    );
    return rowToOrder(rows[0]);
  }

  async getOrder(id: string): Promise<LedgerOrder | null> {
    const { rows } = await this.pool.query(
      `SELECT ${ORDER_COLS} FROM orders WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : rowToOrder(rows[0]);
  }

  async listOrders(): Promise<LedgerOrder[]> {
    const { rows } = await this.pool.query(
      `SELECT ${ORDER_COLS} FROM orders ORDER BY created_at ASC`,
    );
    return rows.map(rowToOrder);
  }

  async updateOrderStatus(id: string, status: string): Promise<LedgerOrder | null> {
    const { rows } = await this.pool.query(
      `UPDATE orders SET status = $2 WHERE id = $1
       RETURNING ${ORDER_COLS}`,
      [id, status],
    );
    return rows.length === 0 ? null : rowToOrder(rows[0]);
  }

  async updateOrderEscrow(
    id: string,
    patch: { escrowAddress?: string; fundTxHash?: string; deliverableTxHash?: string; settleTxHash?: string },
  ): Promise<LedgerOrder | null> {
    // Only the fields present in the patch change; the rest are left alone.
    const sets: string[] = [];
    const values: (string | null)[] = [id];
    const columns: [string, string | undefined][] = [
      ["escrow_address", patch.escrowAddress],
      ["fund_tx_hash", patch.fundTxHash],
      ["deliverable_tx_hash", patch.deliverableTxHash],
      ["settle_tx_hash", patch.settleTxHash],
    ];
    for (const [column, value] of columns) {
      if (value !== undefined) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.getOrder(id);
    const { rows } = await this.pool.query(
      `UPDATE orders SET ${sets.join(", ")} WHERE id = $1 RETURNING ${ORDER_COLS}`,
      values,
    );
    return rows.length === 0 ? null : rowToOrder(rows[0]);
  }

  async saveReport(orderId: string, report: StoredReportData): Promise<StoredReportData> {
    await this.pool.query(
      `INSERT INTO deliveries (order_id, status, stage, data, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (order_id) DO UPDATE SET status = EXCLUDED.status, stage = EXCLUDED.stage, data = EXCLUDED.data, updated_at = now()`,
      [orderId, report.status, report.stage, JSON.stringify(report)],
    );
    return report;
  }

  async getReport(orderId: string): Promise<StoredReportData | null> {
    const { rows } = await this.pool.query(
      `SELECT data FROM deliveries WHERE order_id = $1`,
      [orderId],
    );
    if (rows.length === 0) return null;
    const data = rows[0].data;
    return (typeof data === "string" ? JSON.parse(data) : data) as StoredReportData;
  }

  async appendDecision(d: Omit<LedgerDecision, "prevHash" | "hash" | "createdAt"> & { entry: string }): Promise<LedgerDecision> {
    // One transaction: read the last hash, append the new link. The chain
    // is only as strong as this being atomic, hence the transaction.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const last = await client.query(
        `SELECT hash FROM decision_log WHERE order_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [d.orderId],
      );
      const prevHash = last.rows.length === 0 ? "0".repeat(64) : last.rows[0].hash;
      const hash = chainHash(prevHash, d.entry);
      const { rows } = await client.query(
        `INSERT INTO decision_log (id, order_id, kind, reason, amount_micro_usdc, currency, prev_hash, hash, signature, entry_text, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, order_id, kind, reason, amount_micro_usdc, currency, prev_hash, hash, signature, entry_text, tx_hash, created_at`,
        [d.id, d.orderId, d.kind, d.reason, d.amountMicroUsdc, d.currency ?? "USDT", prevHash, hash, d.signature, d.entry, d.txHash ?? null],
      );
      await client.query("COMMIT");
      return rowToDecision(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listDecisions(orderId: string): Promise<LedgerDecision[]> {
    const { rows } = await this.pool.query(
      `SELECT id, order_id, kind, reason, amount_micro_usdc, currency, prev_hash, hash, signature, entry_text, tx_hash, created_at
       FROM decision_log WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId],
    );
    return rows.map(rowToDecision);
  }

  async verifyOrderChain(orderId: string): Promise<boolean> {
    // Step 2: verify from the stored entry text. Rows written before Step 2
    // have no entry_text; for those, fall back to kind|reason|amount.
    const list = await this.listDecisions(orderId);
    return verifyChain(
      list.map((e) => ({
        prevHash: e.prevHash,
        hash: e.hash,
        entry: e.entryText ?? `${e.kind}|${e.reason}|${e.amountMicroUsdc}`,
      })),
    );
  }

  async recordFxSwap(swap: FxSwapRecord): Promise<FxSwapRecord> {
    await this.pool.query(
      `INSERT INTO fx_swaps (rfq_id, order_id, chain_id, sell_token, buy_token, sell_amount, buy_amount, taker_pays, fee_amount, rate_ray, expires_at, order_deadline, reactor, approval_tx_hash, swap_tx_hash, forced, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (rfq_id) DO UPDATE SET status = EXCLUDED.status, approval_tx_hash = EXCLUDED.approval_tx_hash, swap_tx_hash = EXCLUDED.swap_tx_hash`,
      [
        swap.rfqId, swap.orderId, swap.chainId, swap.sellToken, swap.buyToken, swap.sellAmount, swap.buyAmount,
        swap.takerPays, swap.feeAmount, swap.rateRay, swap.expiresAt, swap.orderDeadline, swap.reactor,
        swap.approvalTxHash ?? null, swap.swapTxHash ?? null, swap.forced ?? false, swap.status,
      ],
    );
    return swap;
  }

  async listFxSwaps(orderId: string): Promise<FxSwapRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT rfq_id, order_id, chain_id, sell_token, buy_token, sell_amount, buy_amount, taker_pays, fee_amount, rate_ray, expires_at, order_deadline, reactor, approval_tx_hash, swap_tx_hash, forced, status
       FROM fx_swaps WHERE order_id = $1 ORDER BY created_at ASC`,
      [orderId],
    );
    return rows.map((r: Record<string, unknown>) => ({
      rfqId: String(r.rfq_id), orderId: String(r.order_id), chainId: Number(r.chain_id),
      sellToken: String(r.sell_token), buyToken: String(r.buy_token), sellAmount: String(r.sell_amount),
      buyAmount: String(r.buy_amount), takerPays: String(r.taker_pays), feeAmount: String(r.fee_amount),
      rateRay: String(r.rate_ray), expiresAt: new Date(String(r.expires_at)).toISOString(),
      orderDeadline: new Date(String(r.order_deadline)).toISOString(), reactor: String(r.reactor),
      approvalTxHash: r.approval_tx_hash ? String(r.approval_tx_hash) : null,
      swapTxHash: r.swap_tx_hash ? String(r.swap_tx_hash) : null,
      forced: Boolean(r.forced), status: r.status as FxSwapRecord["status"],
    }));
  }

  async recordSelfVerification(v: SelfVerificationRecord): Promise<SelfVerificationRecord> {
    await this.pool.query(
      `INSERT INTO self_verifications (id, agent_id, agent_address, verified, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [v.id, v.agentId, v.agentAddress, v.verified, v.reason, v.expiresAt ?? null],
    );
    return v;
  }

  async recordX402Payment(p: X402PaymentRecord): Promise<X402PaymentRecord> {
    await this.pool.query(
      `INSERT INTO x402_payments (id, order_id, agent_id, asset, amount_atomic, pay_to, tx_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET tx_hash = EXCLUDED.tx_hash, status = EXCLUDED.status`,
      [p.id, p.orderId, p.agentId ?? null, p.asset, p.amountAtomic, p.payTo, p.txHash ?? null, p.status],
    );
    return p;
  }

  async reconcile(orderId: string): Promise<Reconciliation> {
    // A tx hash is necessary for "settled", not proof of on-chain confirmation.
    // Confirmation against an RPC is a live step, not a ledger claim (plan §2.5).
    const { rows } = await this.pool.query(
      `SELECT status, tx_hash FROM x402_payments WHERE order_id = $1`,
      [orderId],
    );
    return {
      orderId,
      settled: rows.filter((r: Record<string, unknown>) => r.status === "settled" && r.tx_hash).length,
      unresolved: rows.filter((r: Record<string, unknown>) => r.status === "verified" && !r.tx_hash).length,
      failed: rows.filter((r: Record<string, unknown>) => r.status === "failed" || r.status === "ambiguous").length,
    };
  }

  async createBill(
    bill: Omit<LedgerBill, "status" | "note" | "lastCheckedAt" | "lastRate" | "lastRateAt" | "lastDecision" | "lastDecisionReason" | "lastBpsGap" | "lastNairaSaved" | "fundingNeededUsdt" | "fundingReady" | "fundingPayerWallet" | "fundingTxHashes" | "fundingPaidUsdtAtomic" | "rfqId" | "approvalTxHashes" | "swapTxHash" | "forced" | "payoutTxHash" | "createdAt" | "updatedAt">,
  ): Promise<LedgerBill> {
    const { rows } = await this.pool.query(
      `INSERT INTO bills (id, payer_name, purpose, amount_ngn, supplier_wallet, deadline, min_rate, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'created') RETURNING ${BILL_COLS}`,
      [bill.id, bill.payerName, bill.purpose, bill.amountNgn, bill.supplierWallet, bill.deadline, bill.minRate],
    );
    return rowToBill(rows[0]);
  }

  async getBill(id: string): Promise<LedgerBill | null> {
    const { rows } = await this.pool.query(`SELECT ${BILL_COLS} FROM bills WHERE id = $1`, [id]);
    return rows.length === 0 ? null : rowToBill(rows[0]);
  }

  async listBills(): Promise<LedgerBill[]> {
    const { rows } = await this.pool.query(`SELECT ${BILL_COLS} FROM bills ORDER BY created_at ASC`);
    return rows.map(rowToBill);
  }

  async updateBill(id: string, patch: BillPatch): Promise<LedgerBill | null> {
    // Only the fields present in the patch change; the rest are left alone.
    const sets: string[] = [];
    const values: unknown[] = [id];
    const columns: [string, unknown][] = [
      ["status", patch.status],
      ["note", patch.note === undefined ? undefined : patch.note],
      ["last_checked_at", patch.lastCheckedAt],
      ["last_rate", patch.lastRate === undefined ? undefined : patch.lastRate],
      ["last_rate_at", patch.lastRateAt],
      ["last_decision", patch.lastDecision === undefined ? undefined : patch.lastDecision],
      ["last_decision_reason", patch.lastDecisionReason === undefined ? undefined : patch.lastDecisionReason],
      ["last_bps_gap", patch.lastBpsGap === undefined ? undefined : patch.lastBpsGap],
      ["last_naira_saved", patch.lastNairaSaved === undefined ? undefined : patch.lastNairaSaved],
      ["funding_needed_usdt", patch.fundingNeededUsdt === undefined ? undefined : patch.fundingNeededUsdt],
      ["funding_ready", patch.fundingReady === undefined ? undefined : patch.fundingReady],
      ["funding_payer_wallet", patch.fundingPayerWallet === undefined ? undefined : patch.fundingPayerWallet],
      ["funding_tx_hashes", patch.fundingTxHashes === undefined ? undefined : JSON.stringify(patch.fundingTxHashes)],
      ["funding_paid_usdt_atomic", patch.fundingPaidUsdtAtomic === undefined ? undefined : patch.fundingPaidUsdtAtomic],
      ["rfq_id", patch.rfqId === undefined ? undefined : patch.rfqId],
      ["approval_tx_hashes", patch.approvalTxHashes === undefined ? undefined : JSON.stringify(patch.approvalTxHashes)],
      ["swap_tx_hash", patch.swapTxHash === undefined ? undefined : patch.swapTxHash],
      ["forced", patch.forced],
      ["payout_tx_hash", patch.payoutTxHash === undefined ? undefined : patch.payoutTxHash],
    ];
    for (const [column, value] of columns) {
      if (value !== undefined) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.getBill(id);
    sets.push("updated_at = now()");
    const { rows } = await this.pool.query(
      `UPDATE bills SET ${sets.join(", ")} WHERE id = $1 RETURNING ${BILL_COLS}`,
      values,
    );
    return rows.length === 0 ? null : rowToBill(rows[0]);
  }

  async appendBillEvent(e: Omit<BillEvent, "prevHash" | "hash" | "createdAt"> & { entry: string }): Promise<BillEvent> {
    // One transaction: read the last hash, append the new link.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const last = await client.query(
        `SELECT hash FROM bill_events WHERE bill_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
        [e.billId],
      );
      const prevHash = last.rows.length === 0 ? "0".repeat(64) : last.rows[0].hash;
      const hash = chainHash(prevHash, e.entry);
      const { rows } = await client.query(
        `INSERT INTO bill_events (id, bill_id, kind, reason, rate_seen, bps_gap, tx_hash, prev_hash, hash, entry_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, bill_id, kind, reason, rate_seen, bps_gap, tx_hash, prev_hash, hash, entry_text, created_at`,
        [e.id, e.billId, e.kind, e.reason, e.rateSeen ?? null, e.bpsGap ?? null, e.txHash ?? null, prevHash, hash, e.entry],
      );
      await client.query("COMMIT");
      return rowToBillEvent(rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async listBillEvents(billId: string): Promise<BillEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT id, bill_id, kind, reason, rate_seen, bps_gap, tx_hash, prev_hash, hash, entry_text, created_at
       FROM bill_events WHERE bill_id = $1 ORDER BY created_at ASC`,
      [billId],
    );
    return rows.map(rowToBillEvent);
  }

  async verifyBillChain(billId: string): Promise<boolean> {
    const list = await this.listBillEvents(billId);
    return verifyChain(
      list.map((e) => ({ prevHash: e.prevHash, hash: e.hash, entry: e.entryText ?? `${e.kind}|${e.reason}` })),
    );
  }
}

/** Every column of the bills table, in one place. */
const BILL_COLS =
  "id, payer_name, purpose, amount_ngn, supplier_wallet, deadline, min_rate, status, note, last_checked_at, last_rate, last_rate_at, last_decision, last_decision_reason, last_bps_gap, last_naira_saved, funding_needed_usdt, funding_ready, funding_payer_wallet, funding_tx_hashes, funding_paid_usdt_atomic, rfq_id, approval_tx_hashes, swap_tx_hash, forced, payout_tx_hash, created_at, updated_at";

function rowToBill(r: Record<string, unknown>): LedgerBill {
  return {
    id: String(r.id),
    payerName: String(r.payer_name),
    purpose: String(r.purpose),
    amountNgn: Number(r.amount_ngn),
    supplierWallet: String(r.supplier_wallet),
    deadline: r.deadline instanceof Date ? r.deadline.toISOString() : String(r.deadline),
    minRate: Number(r.min_rate),
    status: String(r.status) as LedgerBill["status"],
    note: r.note === null || r.note === undefined ? null : String(r.note),
    lastCheckedAt: r.last_checked_at instanceof Date ? r.last_checked_at.toISOString() : r.last_checked_at ? String(r.last_checked_at) : null,
    lastRate: r.last_rate === null || r.last_rate === undefined ? null : Number(r.last_rate),
    lastRateAt: r.last_rate_at instanceof Date ? r.last_rate_at.toISOString() : r.last_rate_at ? String(r.last_rate_at) : null,
    lastDecision: r.last_decision === null || r.last_decision === undefined ? null : String(r.last_decision) as LedgerBill["lastDecision"],
    lastDecisionReason: r.last_decision_reason === null || r.last_decision_reason === undefined ? null : String(r.last_decision_reason),
    lastBpsGap: r.last_bps_gap === null || r.last_bps_gap === undefined ? null : Number(r.last_bps_gap),
    lastNairaSaved: r.last_naira_saved === null || r.last_naira_saved === undefined ? null : Number(r.last_naira_saved),
    fundingNeededUsdt: r.funding_needed_usdt === null || r.funding_needed_usdt === undefined ? null : String(r.funding_needed_usdt),
    fundingReady: r.funding_ready === null || r.funding_ready === undefined ? null : Boolean(r.funding_ready),
    fundingPayerWallet: r.funding_payer_wallet === null || r.funding_payer_wallet === undefined ? null : String(r.funding_payer_wallet),
    fundingTxHashes: r.funding_tx_hashes ? JSON.parse(String(r.funding_tx_hashes)) as string[] : [],
    fundingPaidUsdtAtomic: r.funding_paid_usdt_atomic === null || r.funding_paid_usdt_atomic === undefined ? null : String(r.funding_paid_usdt_atomic),
    rfqId: r.rfq_id === null || r.rfq_id === undefined ? null : String(r.rfq_id),
    approvalTxHashes: r.approval_tx_hashes ? JSON.parse(String(r.approval_tx_hashes)) as string[] : [],
    swapTxHash: r.swap_tx_hash === null || r.swap_tx_hash === undefined ? null : String(r.swap_tx_hash),
    forced: Boolean(r.forced),
    payoutTxHash: r.payout_tx_hash === null || r.payout_tx_hash === undefined ? null : String(r.payout_tx_hash),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function rowToBillEvent(r: Record<string, unknown>): BillEvent {
  return {
    id: String(r.id),
    billId: String(r.bill_id),
    kind: String(r.kind) as BillEvent["kind"],
    reason: String(r.reason),
    rateSeen: r.rate_seen === null || r.rate_seen === undefined ? null : Number(r.rate_seen),
    bpsGap: r.bps_gap === null || r.bps_gap === undefined ? null : Number(r.bps_gap),
    txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
    entryText: r.entry_text ? String(r.entry_text) : undefined,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** Every column of the orders table, in one place, so the SELECTs and
 * RETURNINGs in PostgresLedger can't drift out of sync with rowToOrder. */
const ORDER_COLS =
  "id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash, escrow_address, fund_tx_hash, deliverable_tx_hash, settle_tx_hash, pay_currency, price_atomic, price_rate, token_address, vault_address, created_at";

function rowToOrder(r: Record<string, unknown>): LedgerOrder {
  return {
    id: String(r.id),
    jobType: String(r.job_type),
    customerWallet: String(r.customer_wallet),
    description: String(r.description),
    status: String(r.status),
    priceMicroUsdc: Number(r.price_micro_usdc),
    bondMicroUsdc: r.bond_micro_usdc === null || r.bond_micro_usdc === undefined ? undefined : Number(r.bond_micro_usdc),
    cfoAccepted: r.cfo_accepted === null || r.cfo_accepted === undefined ? undefined : Boolean(r.cfo_accepted),
    cfoReason: r.cfo_reason === null || r.cfo_reason === undefined ? undefined : String(r.cfo_reason),
    decisionHash: r.decision_hash === null || r.decision_hash === undefined ? undefined : String(r.decision_hash),
    escrowAddress: r.escrow_address === null || r.escrow_address === undefined ? null : String(r.escrow_address),
    fundTxHash: r.fund_tx_hash === null || r.fund_tx_hash === undefined ? null : String(r.fund_tx_hash),
    deliverableTxHash: r.deliverable_tx_hash === null || r.deliverable_tx_hash === undefined ? null : String(r.deliverable_tx_hash),
    settleTxHash: r.settle_tx_hash === null || r.settle_tx_hash === undefined ? null : String(r.settle_tx_hash),
    payCurrency: (r.pay_currency === null || r.pay_currency === undefined ? "USDT" : String(r.pay_currency)) as LedgerOrder["payCurrency"],
    priceAtomic: r.price_atomic === null || r.price_atomic === undefined ? undefined : String(r.price_atomic),
    priceRate: r.price_rate === null || r.price_rate === undefined ? null : String(r.price_rate),
    tokenAddress: r.token_address === null || r.token_address === undefined ? null : String(r.token_address),
    vaultAddress: r.vault_address === null || r.vault_address === undefined ? null : String(r.vault_address),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function rowToDecision(r: Record<string, unknown>): LedgerDecision {
  return {
    id: String(r.id),
    orderId: String(r.order_id),
    kind: String(r.kind),
    reason: String(r.reason),
    amountMicroUsdc: Number(r.amount_micro_usdc),
    currency: (r.currency === null || r.currency === undefined ? "USDT" : String(r.currency)) as LedgerDecision["currency"],
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
    signature: String(r.signature),
    entryText: r.entry_text ? String(r.entry_text) : undefined,
    txHash: r.tx_hash ? String(r.tx_hash) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}
