"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Nav from "@/components/Nav";
import {
  connectInjected,
  ensureChain,
  fetchChainConfig,
  fundBillTransfer,
  readTokenBalance,
} from "@/lib/contracts";
import { billFundingView, formatBillUsdt } from "@/lib/billFunding";

/**
 * One bill's page — where it stands, and the receipts.
 *
 * It reads the real /api/bills/[id] record and refreshes every 10
 * seconds: the rate seen, the rate the payer named, whether the USDT is
 * in the agent wallet, the swap, and the payout to the supplier. Every
 * transaction links to Celoscan. Nothing is invented: while the bill is
 * waiting, the page says so, and the funding it needs is shown exactly.
 */
interface BillDetail {
  bill: {
    id: string;
    payerName: string;
    purpose: string;
    amountNgn: number;
    supplierWallet: string;
    deadline: string;
    minRate: number;
    status: "created" | "watching" | "converting" | "paid" | "failed";
    note: string | null;
    lastCheckedAt: string | null;
    lastRate: number | null;
    lastRateAt: string | null;
    lastDecision: string | null;
    lastDecisionReason: string | null;
    lastBpsGap: number | null;
    lastNairaSaved: number | null;
    fundingNeededUsdt: string | null;
    fundingReady: boolean | null;
    fundingPayerWallet: string | null;
    fundingTxHashes: string[];
    fundingPaidUsdtAtomic: string | null;
    rfqId: string | null;
    approvalTxHashes: string[];
    swapTxHash: string | null;
    forced: boolean;
    payoutTxHash: string | null;
    createdAt: string;
    explorerUrl: string;
  };
  events: { id: string; kind: string; reason: string; rateSeen: number | null; txHash: string | null; createdAt: string }[];
  chainOk: boolean;
}

const EVENT_LABELS: Record<string, string> = {
  created: "Bill sent",
  funded: "You paid for the bill",
  quote: "Rate checked",
  refuse: "Waited — rate too low",
  convert: "Rate good — changing the money",
  swap: "Changed USDT to cNGN",
  payout: "Paid the supplier",
  paid: "Done",
  failed: "Didn't go through",
  waiting: "Still waiting",
};

function formatNaira(n: number): string {
  return `₦${n.toLocaleString("en-NG")}`;
}

function formatRate(r: number): string {
  return `₦${r.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per $1`;
}

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function BillPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<BillDetail | null>(null);
  const [agentWallet, setAgentWallet] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [payStatus, setPayStatus] = useState<"idle" | "connecting" | "checking" | "paying" | "reporting" | "done">("idle");
  const [payError, setPayError] = useState("");
  const [manualHash, setManualHash] = useState("");
  const [manualOpen, setManualOpen] = useState(false);

  async function load() {
    try {
      const res = await fetch(`/api/bills/${id}`);
      const json = (await res.json().catch(() => null)) as BillDetail & { error?: string };
      if (!res.ok || !json.bill) {
        setError(json.error ?? "No bill with that id.");
        return;
      }
      setData(json);
    } catch {
      setError("Could not load the bill — check your connection and try again.");
    }
  }

  useEffect(() => {
    async function loadChain() {
      try {
        const res = await fetch("/api/chain");
        const json = (await res.json().catch(() => null)) as { agentWallet?: string };
        if (json.agentWallet) setAgentWallet(json.agentWallet);
      } catch {
        // The funding address is a nice-to-have here; the bill still loads without it.
      }
    }
    load();
    loadChain();
    const timer = setInterval(load, 10_000);
    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Pay for this bill from the payer's own wallet: connect the browser
   * extension, check they hold enough USDT, send one tagged USDT
   * transfer to the agent wallet, then report the hash so the server
   * can check it onchain and record the funding for this bill.
   */
  async function reportFunding(txHash: string, payerWallet: string, amountAtomic: bigint) {
    const res = await fetch(`/api/bills/${id}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        funding: { txHash, payerWallet, amountAtomic: amountAtomic.toString() },
      }),
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      throw new Error(json?.error ?? "The payment went through, but we couldn't record it — keep the transaction hash and tell us about it.");
    }
  }

  async function handlePay(remainingAtomic: bigint) {
    setPayError("");
    setPayStatus("connecting");
    try {
      // Recheck before asking for a signature: polling or another tab may have changed the bill.
      const latestResponse = await fetch(`/api/bills/${id}`, { cache: "no-store" });
      const latest = await latestResponse.json() as BillDetail;
      if (!latestResponse.ok || !latest.bill) throw new Error("Could not confirm the bill's latest funding requirement. Refresh and try again.");
      setData(latest);
      const current = billFundingView(latest.bill);
      if (!current.canPay) throw new Error(current.waitingForTargetRate ? "Your payment is recorded. We are waiting for your target rate before requesting any additional funding." : "No additional payment is needed right now.");
      if (current.remainingAtomic !== remainingAtomic) throw new Error("The quote changed. Review the updated amount before confirming a payment.");
      const chain = await fetchChainConfig();
      const account = await connectInjected();
      await ensureChain(chain.chainId);
      setPayStatus("checking");
      const balance = await readTokenBalance(chain, account);
      if (balance < remainingAtomic) {
        throw new Error(
          `Your wallet holds ${formatBillUsdt(balance)} USDT — you need ${formatBillUsdt(remainingAtomic)} for this bill. Add USDT first, then try again.`,
        );
      }
      setPayStatus("paying");
      const { txHash } = await fundBillTransfer({ account, chain, amountAtomic: remainingAtomic });
      setPayStatus("reporting");
      await reportFunding(txHash, account, remainingAtomic);
      setPayStatus("done");
      await load();
    } catch (err) {
      setPayStatus("idle");
      setPayError(err instanceof Error ? err.message : "The payment didn't go through — try again.");
    }
  }

  /** The button didn't work, so the payer sent the USDT themselves:
   * connect the wallet that paid, paste the hash, and the server
   * checks it onchain before recording it for this bill. */
  async function handleManualReport(remainingAtomic: bigint) {
    const hash = manualHash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      setPayError("That transaction hash doesn't look right — it should start with 0x and be 66 characters.");
      return;
    }
    setPayError("");
    setPayStatus("connecting");
    try {
      const chain = await fetchChainConfig();
      const account = await connectInjected();
      await ensureChain(chain.chainId);
      setPayStatus("reporting");
      await reportFunding(hash, account, remainingAtomic);
      setPayStatus("done");
      setManualOpen(false);
      setManualHash("");
      await load();
    } catch (err) {
      setPayStatus("idle");
      setPayError(err instanceof Error ? err.message : "That payment couldn't be recorded — check the hash and try again.");
    }
  }

  const bill = data?.bill;
  const { paidAtomic, neededAtomic, remainingAtomic, waitingForTargetRate, canPay } = billFundingView(bill);
  const billOpen = bill?.status === "created" || bill?.status === "watching";
  const payBusy = payStatus !== "idle" && payStatus !== "done";
  const payStatusWords: Record<string, string> = {
    connecting: "Connecting your wallet…",
    checking: "Checking your USDT…",
    paying: "Waiting for you to approve the payment in your wallet…",
    reporting: "Payment sent — recording it for this bill…",
    done: "Paid.",
  };

  const statusWords: Record<string, string> = {
    created: "We have your bill. The next check runs every few minutes — it looks at the rate and at the USDT in the agent wallet.",
    watching: paidAtomic > 0n && neededAtomic !== null &&
      (bill?.note?.startsWith("To pay this bill we need") || bill?.note?.startsWith("You paid $"))
      ? waitingForTargetRate
        ? "Payment received — waiting for your target rate."
        : remainingAtomic > 0n
          ? `Payment received — ${formatBillUsdt(remainingAtomic)} USDT more is needed at the latest rate.`
          : "Payment received — waiting for the next processing check."
      : bill?.note ?? "Watching the rate. Nothing has moved yet.",
    converting: "The money is being changed and paid — the cNGN is on its way to your supplier.",
    paid: "Paid. Your supplier has the cNGN.",
    failed: bill?.note ?? "Something went wrong — nothing was paid. The receipt below says what happened.",
  };

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96, maxWidth: 820 }}>
        <a href="/bills" style={{ fontSize: 14, color: "var(--muted)" }}>← Back to naira bills</a>
        <a href="/bills/history" style={{ marginLeft: 20, fontSize: 14 }}>My bill history →</a>
        {error && !data && (
          <div className="card pad" style={{ marginTop: 24 }}>
            <h1 style={{ fontSize: 28 }}>Bill not found</h1>
            <p style={{ marginTop: 8, color: "var(--ink-2)" }}>{error}</p>
          </div>
        )}
        {!error && !data && <p style={{ marginTop: 24, color: "var(--muted)" }}>Loading your bill…</p>}
        {data && bill && (
          <>
            <div style={{ marginTop: 24 }}>
              <span className="chip live">
                <span className="dot" /> {bill.status}
              </span>
            </div>
            <h1 style={{ fontSize: 36, marginTop: 14 }}>
              {formatNaira(bill.amountNgn)} for {bill.purpose}
            </h1>
            <p style={{ marginTop: 10, fontSize: "var(--lede)", color: "var(--ink-2)", lineHeight: 1.6 }}>
              {statusWords[bill.status]}
            </p>

            <div className="card pad" style={{ marginTop: 24, display: "grid", gap: 12 }}>
              <p><b>Who owes it:</b> {bill.payerName}</p>
              <p>
                <b>Supplier:</b>{" "}
                <a href={`${bill.explorerUrl}/address/${bill.supplierWallet}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
                  {shortAddress(bill.supplierWallet)} ↗
                </a>
              </p>
              <p><b>Due:</b> {new Date(bill.deadline).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" })}</p>
              <p><b>Lowest rate you will accept:</b> {formatRate(bill.minRate)}</p>
              {bill.lastRate !== null && (
                <p>
                  <b>Latest rate seen:</b> {formatRate(bill.lastRate)}
                  {bill.lastRate >= bill.minRate ? " — at or above your minimum." : " — below your minimum, so we wait."}
                  {bill.lastRateAt && (
                    <span style={{ color: "var(--muted)" }}> ({new Date(bill.lastRateAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })})</span>
                  )}
                </p>
              )}
              {bill.lastDecisionReason && (
                <p><b>Last decision:</b> {bill.lastDecisionReason}</p>
              )}
              {bill.lastNairaSaved !== null && bill.lastNairaSaved > 0 && (
                <p><b>Waiting has saved about {formatNaira(bill.lastNairaSaved)} so far</b> vs changing the money at the rate seen.</p>
              )}
              {billOpen && neededAtomic === null && (
                <p>The worker is checking the rate — the amount to pay will show here once it has.</p>
              )}
              {billOpen && neededAtomic !== null && remainingAtomic === 0n && paidAtomic > 0n && (
                <p>
                  <b>You paid {formatBillUsdt(paidAtomic)} USDT</b> — the money is in the agent wallet and we are watching the rate.
                  {bill.fundingPayerWallet && (
                    <> It came from <span className="mono" style={{ fontSize: 13 }}>{shortAddress(bill.fundingPayerWallet)}</span>.</>
                  )}
                </p>
              )}
              {billOpen && neededAtomic !== null && remainingAtomic > 0n && (
                <div>
                  <p>
                    <b>
                      {paidAtomic > 0n
                        ? `You paid ${formatBillUsdt(paidAtomic)} USDT — the current quote is ${formatBillUsdt(remainingAtomic)} higher.`
                        : `To pay this bill we need ${formatBillUsdt(remainingAtomic)} USDT.`}
                    </b>{" "}
                    {waitingForTargetRate
                      ? "The rate is below your minimum. We will recheck the quote before requesting a top-up; you do not need to send more while we wait."
                      : "Pay from your own Celo wallet. You need USDT and a little CELO for gas. The payment goes to the agent wallet:"}
                  </p>
                  <p className="mono" style={{ fontSize: 13, wordBreak: "break-all", marginTop: 8 }}>
                    {agentWallet ?? "Loading the agent wallet…"}
                  </p>
                  {agentWallet && (
                    <p style={{ marginTop: 6 }}>
                      <a href={`${bill.explorerUrl}/address/${agentWallet}`} target="_blank" rel="noreferrer">
                        See the agent wallet on Celoscan ↗
                      </a>
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => handlePay(remainingAtomic)}
                    disabled={payBusy || !canPay}
                    style={{
                      marginTop: 12,
                      padding: "12px 20px",
                      borderRadius: 10,
                      border: "none",
                      background: "var(--forest, #13271c)",
                      color: "#fff",
                      fontSize: 16,
                      fontWeight: 600,
                      cursor: payBusy ? "wait" : !canPay ? "not-allowed" : "pointer",
                      opacity: payBusy || !canPay ? 0.7 : 1,
                    }}
                  >
                    {payBusy ? payStatusWords[payStatus] : !canPay
                      ? waitingForTargetRate ? "Waiting for your target rate" : "No payment needed"
                      : paidAtomic > 0n ? `Top up ${formatBillUsdt(remainingAtomic)} USDT` : `Pay ${formatBillUsdt(remainingAtomic)} USDT from my wallet`}
                  </button>
                  {payStatus === "done" && (
                    <p style={{ marginTop: 8 }}><b>Paid.</b> The money is in the agent wallet — we are watching the rate.</p>
                  )}
                  {payError && (
                    <p style={{ marginTop: 8, color: "#a33" }}>{payError}</p>
                  )}
                  <p style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      onClick={() => setManualOpen((v) => !v)}
                      disabled={payBusy}
                      style={{ background: "none", border: "none", padding: 0, color: "var(--muted)", fontSize: 14, textDecoration: "underline", cursor: "pointer" }}
                    >
                      {manualOpen ? "Hide the manual payment form" : "I sent the USDT myself — report the payment"}
                    </button>
                  </p>
                  {manualOpen && (
                    <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                      <p style={{ fontSize: 14, color: "var(--ink-2)" }}>
                        {waitingForTargetRate ? "Only report a transfer you already sent. Do not send a new top-up while we wait for your target rate." : <>Send exactly {formatBillUsdt(remainingAtomic)} USDT to the agent wallet above, then paste the transaction hash here.</>}
                        We check it onchain before recording it for this bill.
                      </p>
                      <input
                        value={manualHash}
                        onChange={(e) => setManualHash(e.target.value)}
                        placeholder="0x… transaction hash"
                        className="mono"
                        style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--line, #ddd)", fontSize: 13, width: "100%" }}
                      />
                      <div>
                        <button
                          type="button"
                          onClick={() => handleManualReport(remainingAtomic)}
                          disabled={payBusy}
                          style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid var(--line, #ddd)", background: "var(--surface, #fff)", fontSize: 15, fontWeight: 600, cursor: payBusy ? "wait" : "pointer" }}
                        >
                          {payStatus === "reporting" ? "Checking the payment…" : "Report my payment"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {(bill.fundingTxHashes.length > 0 || bill.approvalTxHashes.length > 0 || bill.swapTxHash || bill.payoutTxHash) && (
              <div style={{ marginTop: 24 }}>
                <h2 style={{ fontSize: 20 }}>On the chain</h2>
                <div className="card pad" style={{ marginTop: 12, display: "grid", gap: 12 }}>
                  {bill.fundingTxHashes.map((h) => (
                    <p key={h}>
                      <b>You paid (USDT):</b>{" "}
                      <a href={`${bill.explorerUrl}/tx/${h}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {h.slice(0, 18)}… ↗
                      </a>{" "}
                      <span style={{ color: "var(--muted)" }}>— tagged as Ikenga work.</span>
                    </p>
                  ))}
                  {bill.approvalTxHashes.map((h, i) => (
                    <p key={h}>
                      <b>Approval {bill.approvalTxHashes.length > 1 ? i + 1 : ""}:</b>{" "}
                      <a href={`${bill.explorerUrl}/tx/${h}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {h.slice(0, 18)}… ↗
                      </a>{" "}
                      <span style={{ color: "var(--muted)" }}>— tagged as Ikenga work.</span>
                    </p>
                  ))}
                  {bill.swapTxHash && (
                    <p>
                      <b>Swap (USDT → cNGN):</b>{" "}
                      <a href={`${bill.explorerUrl}/tx/${bill.swapTxHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {bill.swapTxHash.slice(0, 18)}… ↗
                      </a>{" "}
                      <span style={{ color: "var(--muted)" }}>
                        — {bill.forced ? "done at the deadline, below your minimum. " : ""}carries the exchange&apos;s tag, not ours.
                      </span>
                    </p>
                  )}
                  {bill.payoutTxHash && (
                    <p>
                      <b>Paid to the supplier (cNGN):</b>{" "}
                      <a href={`${bill.explorerUrl}/tx/${bill.payoutTxHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {bill.payoutTxHash.slice(0, 18)}… ↗
                      </a>{" "}
                      <span style={{ color: "var(--muted)" }}>— tagged as Ikenga work.</span>
                    </p>
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 24 }}>
              <h2 style={{ fontSize: 20 }}>Receipts</h2>
              {data.events.length === 0 && <p style={{ marginTop: 12, color: "var(--muted)" }}>No receipts yet.</p>}
              <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
                {data.events.map((e) => (
                  <div key={e.id} className="card pad">
                    <p>
                      <b>{EVENT_LABELS[e.kind] ?? e.kind}</b>{" "}
                      <span style={{ color: "var(--muted)", fontSize: 13 }}>
                        {new Date(e.createdAt).toLocaleString("en-NG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </p>
                    <p style={{ marginTop: 6, color: "var(--ink-2)", lineHeight: 1.6 }}>{e.reason}</p>
                    {e.rateSeen !== null && <p className="mono" style={{ marginTop: 6, fontSize: 12, color: "var(--muted)" }}>Rate seen: {formatRate(e.rateSeen)}</p>}
                    {e.txHash && (
                      <p style={{ marginTop: 6 }}>
                        <a href={`${bill.explorerUrl}/tx/${e.txHash}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>
                          {e.txHash.slice(0, 18)}… ↗
                        </a>
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <p className="mono" style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
                {data.chainOk ? "Receipts check out — the chain is intact." : "Receipts could not be verified right now."}
              </p>
            </div>
          </>
        )}
      </main>
    </>
  );
}

