/**
 * Ikenga agent runner — Step 2.
 *
 * The job loop, in order:
 *   1. Price the job with the deterministic CFO function (no model).
 *   2. Verify the agent's Self Agent ID (async, on-chain) and pass the
 *      result into the pure decide() — the CFO serves/pays an agent ONLY
 *      after this gate passes (Track 3). Refusal is recorded as
 *      kind "self-refuse" in the hash-chained ledger.
 *   3. Execute the work. Step 2: the deliverable itself is still a
 *      labelled stub ("work-stubbed") — the money path is real, the
 *      creative work is not yet automated. The UI and ledger say so.
 *   4. Pay tools via x402, one payment per tool call, pinned payees only
 *      (ToolRegistry). No-double-pay: a post-sign timeout is "ambiguous",
 *      recorded, and never retried by the same run.
 *   5. If the job has a naira leg, run the FX leg (decideFx): convert at
 *      or above the minimum rate, refuse with a receipt below it, force
 *      convert at the deadline with the concession logged. Then send the
 *      cNGN to the named supplier.
 *   6. Record every step in the hash-chained ledger with tx hashes.
 *
 * `decide()` and `decideFx()` are pure and fully testable. `runJob()` takes
 * its money-moving dependencies as injectable functions so tests can use
 * fakes; the defaults fail closed (no env = no payment, recorded as such).
 */
import { priceJob, type JobType, type Quote } from "@ikenga/shared";
import { verifySelfAgentId, type SelfVerificationResult } from "@ikenga/payments";
import { MemoryLedger, type Ledger } from "@ikenga/ledger";
import { decideFx, type FxDecision } from "./fx.js";
import { runMarketReport, type MarketReportResult } from "./report.js";
import { ToolRegistry } from "./tools.js";

export interface AgentDecision {
  jobType: JobType;
  quote: Quote;
  selfVerified: boolean;
  selfReason: string;
  action: "proceed" | "refuse";
  reason: string;
}

/**
 * Pure decision: price the job, check the Self gate result (passed in as
 * data — decide() never calls the network), refuse or proceed.
 * The caller must await verifySelfAgentId() and pass the result in.
 */
export function decide(input: {
  jobType: JobType;
  toolCostUsdc: number;
  accepted: number;
  quoted: number;
  agentId: string;
  selfVerified: boolean;
  selfReason: string;
}): AgentDecision {
  const quote = priceJob(input);
  if (!quote.accepted) {
    return { jobType: input.jobType, quote, selfVerified: input.selfVerified, selfReason: input.selfReason, action: "refuse", reason: quote.reason };
  }
  if (!input.selfVerified) {
    return {
      jobType: input.jobType,
      quote,
      selfVerified: false,
      selfReason: input.selfReason,
      action: "refuse",
      reason: `CFO refused: agent ${input.agentId} has no verified Self Agent ID. ${input.selfReason}`,
    };
  }
  return {
    jobType: input.jobType,
    quote,
    selfVerified: true,
    selfReason: input.selfReason,
    action: "proceed",
    reason: "Priced within limits and agent identity verified.",
  };
}

export interface FxObligation {
  /** Naira obligation, whole cNGN. */
  naira: number;
  /** Minimum acceptable rate, cNGN per 1 USDT. */
  minRate: number;
  /** Deadline (ISO). */
  deadline: string;
  /** Named supplier's Celo wallet — cNGN is sent here, and only here. */
  supplierWallet: string;
}

export interface ToolCall {
  service: string;
  payTo: string;
  amountAtomic: string;
  asset: "USDT" | "USDC" | "cNGN";
}

export interface RunJobDeps {
  /** Defaults to the real on-chain Self gate. */
  verifySelf?: (agentAddress: string, agentId?: string) => Promise<SelfVerificationResult>;
  /** Pay one tool call via x402. Defaults to refusing (no sellers configured). */
  payTool?: (call: ToolCall) => Promise<{ status: "settled" | "ambiguous" | "failed"; txHash?: string; reason: string }>;
  /** Obtain a firm Textile quote. Defaults to no quote (wait). */
  getFxQuote?: (obligation: FxObligation) => Promise<{ rate: number; expiresAt: string } | null>;
  /** Execute a firm swap and return its tx hash. Defaults to not executed. */
  executeFxSwap?: (obligation: FxObligation, rate: number) => Promise<{
    txHash: string;
    rfqId: string;
    sellAmount: string;
    buyAmount: string;
    takerPays: string;
    feeAmount: string;
    rateRay: string;
    expiresAt: string;
    orderDeadline: string;
  }>;
  /** Send cNGN to the named supplier. Defaults to not executed. */
  sendCngn?: (to: string, amountAtomic: string) => Promise<{ txHash: string }>;
  /**
   * Do the creative work. Default: a market-report job is really done by
   * the team (Scout, Researcher, Writer, Analyst, Auditor, on OpenAI);
   * every other job type is still a labelled stub until its own delivery
   * is built.
   */
  doWork?: (jobType: JobType) => Promise<{ deliverable: string; note: string; report?: MarketReportResult }>;
  /** Clock override for tests (ISO). */
  now?: string;
}

export interface RunJobResult {
  decision: AgentDecision;
  fxDecision?: FxDecision;
  toolPayments: { service: string; status: string; txHash?: string }[];
  cngnPayoutTxHash?: string;
  /** The delivered work, when the job type has a real delivery (market-report). */
  report?: MarketReportResult;
}

export class AgentRunner {
  private tools = new ToolRegistry();

  constructor(private ledger: Ledger = new MemoryLedger()) {}

  /** Register a pinned tool seller (see tools.ts). Empty by default — safe. */
  registerToolSeller(service: string, payTo: string, maxPriceAtomic: string, asset: "USDT" | "USDC" | "cNGN", network: "eip155:42220" | "eip155:11142220" = "eip155:42220"): void {
    this.tools.register({ service, payTo, maxPriceAtomic, asset, network });
  }

  private async log(orderId: string, kind: string, reason: string, amountMicroUsdc: number, txHash?: string): Promise<void> {
    const entry = `${kind}|${reason}|${amountMicroUsdc}`;
    await this.ledger.appendDecision({
      id: `dec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      orderId,
      kind,
      reason,
      amountMicroUsdc,
      signature: "0xikenga-step2",
      entry,
      txHash: txHash ?? null,
    });
  }

  async runJob(
    input: {
      jobType: JobType;
      toolCostUsdc: number;
      accepted: number;
      quoted: number;
      agentId: string;
      agentAddress: string;
      orderId: string;
      /** The customer's brief, as typed in the Hire form. */
      description?: string;
      obligation?: FxObligation;
      toolCalls?: ToolCall[];
    },
    deps: RunJobDeps = {},
  ): Promise<RunJobResult> {
    const now = deps.now ?? new Date().toISOString();
    const verifySelf = deps.verifySelf ?? ((address: string, id?: string) => verifySelfAgentId(address, id));
    const self = await verifySelf(input.agentAddress, input.agentId);
    await this.ledger.recordSelfVerification({
      id: `self_${Date.now()}`,
      agentId: self.agentId,
      agentAddress: self.agentAddress,
      verified: self.verified,
      reason: self.reason,
      expiresAt: self.expiresAt ?? null,
      checkedAt: self.checkedAt,
    });

    const decision = decide({
      jobType: input.jobType,
      toolCostUsdc: input.toolCostUsdc,
      accepted: input.accepted,
      quoted: input.quoted,
      agentId: input.agentId,
      selfVerified: self.verified,
      selfReason: self.reason,
    });
    await this.log(
      input.orderId,
      decision.action === "proceed" ? "quote" : self.verified ? "refuse" : "self-refuse",
      decision.reason,
      decision.quote.priceUsdc * 1_000_000,
    );
    if (decision.action === "refuse") {
      return { decision, toolPayments: [] };
    }

    // Work: a market-report job is really done by the team; every other
    // job type is still a labelled stub until its own delivery is built.
    let report: MarketReportResult | undefined;
    const work = deps.doWork
      ? await deps.doWork(input.jobType)
      : input.jobType === "market-report" && process.env.OPENAI_API_KEY
        ? await (async () => {
            const r = await runMarketReport({ brief: input.description ?? "Market report" });
            report = r;
            return {
              deliverable: r.report,
              note:
                r.status === "delivered"
                  ? `Market report delivered — ${r.steps.length} steps, ${r.sources.length} sources, about $${r.totalCostUsd.toFixed(4)} of AI time.`
                  : `Market report could not be delivered: ${r.reason ?? "no reason given"}`,
              report: r,
            };
          })()
        : {
            deliverable: "",
            note:
              input.jobType === "market-report"
                ? "Market report is ready to be done, but the AI is not connected yet — no key on the server."
                : "work-stubbed: deliverable not yet automated — money path only",
          };
    if (work.report) report = work.report;
    if (report) {
      for (const step of report.steps) {
        await this.log(
          input.orderId,
          "quote",
          `${step.agent}: ${step.what}${step.costUsd !== undefined ? ` (about $${step.costUsd.toFixed(4)} of AI time)` : ""}`,
          Math.round((step.costUsd ?? 0) * 1_000_000),
        );
      }
    }
    await this.log(input.orderId, "quote", `Work: ${work.note}`, 0);

    // Tool payments via x402, pinned payees only, no-double-pay.
    const toolPayments: RunJobResult["toolPayments"] = [];
    for (const call of input.toolCalls ?? []) {
      const check = this.tools.checkPayment(call.service, call.payTo, call.amountAtomic);
      if (!check.ok) {
        await this.log(input.orderId, "refuse", check.reason, 0);
        toolPayments.push({ service: call.service, status: "refused" });
        continue;
      }
      const pay = deps.payTool
        ? await deps.payTool(call)
        : { status: "failed" as const, reason: "No x402 payer configured — payment not attempted." };
      await this.ledger.recordX402Payment({
        id: `x402_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        orderId: input.orderId,
        agentId: input.agentId,
        asset: call.asset,
        amountAtomic: call.amountAtomic,
        payTo: call.payTo,
        txHash: pay.txHash ?? null,
        status: pay.status === "settled" ? "settled" : pay.status === "ambiguous" ? "ambiguous" : "failed",
      });
      await this.log(
        input.orderId,
        "x402-settle",
        `Tool ${call.service}: ${pay.status}${pay.reason ? ` — ${pay.reason}` : ""}`,
        Number(call.amountAtomic) / 1_000_000,
        pay.txHash,
      );
      toolPayments.push({ service: call.service, status: pay.status, txHash: pay.txHash });
    }

    // FX leg (only when the job has a naira obligation).
    let fxDecision: FxDecision | undefined;
    let cngnPayoutTxHash: string | undefined;
    if (input.obligation) {
      const quote = deps.getFxQuote ? await deps.getFxQuote(input.obligation) : null;
      fxDecision = decideFx({
        obligationNaira: input.obligation.naira,
        minRate: input.obligation.minRate,
        deadline: input.obligation.deadline,
        now,
        quote: quote ?? null,
      });
      const fxKind = fxDecision.action === "refuse" ? "fx-refuse" : "fx-quote";
      await this.log(input.orderId, fxKind, fxDecision.reason, 0);
      if (fxDecision.action === "convert" || fxDecision.action === "force-convert") {
        if (!deps.executeFxSwap || !deps.sendCngn) {
          await this.log(input.orderId, "fx-refuse", "FX decision was to convert, but no swap executor is configured — conversion not executed.", 0);
        } else {
          const swap = await deps.executeFxSwap(input.obligation, fxDecision.rateSeen ?? input.obligation.minRate);
          await this.ledger.recordFxSwap({
            rfqId: swap.rfqId,
            orderId: input.orderId,
            chainId: 42220,
            sellToken: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
            buyToken: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
            sellAmount: swap.sellAmount,
            buyAmount: swap.buyAmount,
            takerPays: swap.takerPays,
            feeAmount: swap.feeAmount,
            rateRay: swap.rateRay,
            expiresAt: swap.expiresAt,
            orderDeadline: swap.orderDeadline,
            reactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3",
            swapTxHash: swap.txHash,
            forced: fxDecision.action === "force-convert",
            status: "submitted",
          });
          await this.log(input.orderId, "fx-swap", `Swap executed${fxDecision.action === "force-convert" ? " (forced, concession logged)" : ""}.`, 0, swap.txHash);
          const payout = await deps.sendCngn(input.obligation.supplierWallet, swap.buyAmount);
          cngnPayoutTxHash = payout.txHash;
          await this.log(input.orderId, "fx-swap", `cNGN sent to named supplier ${input.obligation.supplierWallet}.`, 0, payout.txHash);
        }
      }
    }

    return { decision, fxDecision, toolPayments, cngnPayoutTxHash, report };
  }
}
