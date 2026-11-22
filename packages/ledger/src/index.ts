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
  /** Bond the CFO puts up (micro-USDC). Defaults to 100000 ($0.10) for old rows. */
  bondMicroUsdc?: number;
  cfoAccepted?: boolean;
  cfoReason?: string;
  decisionHash?: string;
  createdAt: string;
}

/** The delivered work for a job, plus — while it is running — the stage
 * state the next chunked step needs to pick up where the last one stopped.
 * Stored as one JSON document in the deliveries table (and in memory for
 * the MemoryLedger). `stage` is the next stage to run; 0 means finished. */
export interface StoredReportData {
  report: string;
  sources: { title: string; url: string }[];
  steps: { agent: "Scout" | "Researcher" | "Writer" | "Analyst" | "Auditor"; what: string; detail: string; model?: string; tokens?: number; costUsd?: number }[];
  totalTokens: number;
  totalCostUsd: number;
  status: "delivered" | "refused" | "in-progress";
  reason?: string;
  revisions: number;
  deliveredAt: string;
  stage: number;
  /** Pages Scout read (kept so later stages — and a revision — reuse them). */
  pages?: { title: string; url: string; text: string }[];
  plan?: string;
  checkText?: string;
  revisionNote?: string;
}

export interface LedgerDecision {
  id: string;
  orderId: string;
  kind: string;
  reason: string;
  amountMicroUsdc: number;
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

export interface Ledger {
  createOrder(order: Omit<LedgerOrder, "createdAt" | "priceMicroUsdc"> & { priceMicroUsdc?: number }): Promise<LedgerOrder>;
  getOrder(id: string): Promise<LedgerOrder | null>;
  listOrders(): Promise<LedgerOrder[]>;
  /** Change an order's status (accept / reject / in-progress / delivered). */
  updateOrderStatus(id: string, status: string): Promise<LedgerOrder | null>;
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
}

export class MemoryLedger implements Ledger {
  private orders = new Map<string, LedgerOrder>();
  private decisions = new Map<string, LedgerDecision[]>();
  private fxSwaps = new Map<string, FxSwapRecord[]>();
  private selfVerifications: SelfVerificationRecord[] = [];
  private x402Payments = new Map<string, X402PaymentRecord[]>();
  private reports = new Map<string, StoredReportData>();

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
      `INSERT INTO orders (id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash, created_at`,
      [order.id, order.jobType, order.customerWallet, order.description, order.status, order.priceMicroUsdc ?? 1_000_000,
       order.bondMicroUsdc ?? 100_000, order.cfoAccepted ?? true, order.cfoReason ?? "", order.decisionHash ?? ""],
    );
    return rowToOrder(rows[0]);
  }

  async getOrder(id: string): Promise<LedgerOrder | null> {
    const { rows } = await this.pool.query(
      `SELECT id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash, created_at FROM orders WHERE id = $1`,
      [id],
    );
    return rows.length === 0 ? null : rowToOrder(rows[0]);
  }

  async listOrders(): Promise<LedgerOrder[]> {
    const { rows } = await this.pool.query(
      `SELECT id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash, created_at FROM orders ORDER BY created_at ASC`,
    );
    return rows.map(rowToOrder);
  }

  async updateOrderStatus(id: string, status: string): Promise<LedgerOrder | null> {
    const { rows } = await this.pool.query(
      `UPDATE orders SET status = $2 WHERE id = $1
       RETURNING id, job_type, customer_wallet, description, status, price_micro_usdc, bond_micro_usdc, cfo_accepted, cfo_reason, decision_hash, created_at`,
      [id, status],
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
        `INSERT INTO decision_log (id, order_id, kind, reason, amount_micro_usdc, prev_hash, hash, signature, entry_text, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, order_id, kind, reason, amount_micro_usdc, prev_hash, hash, signature, entry_text, tx_hash, created_at`,
        [d.id, d.orderId, d.kind, d.reason, d.amountMicroUsdc, prevHash, hash, d.signature, d.entry, d.txHash ?? null],
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
      `SELECT id, order_id, kind, reason, amount_micro_usdc, prev_hash, hash, signature, entry_text, tx_hash, created_at
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
}

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
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
    signature: String(r.signature),
    entryText: r.entry_text ? String(r.entry_text) : undefined,
    txHash: r.tx_hash ? String(r.tx_hash) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}
