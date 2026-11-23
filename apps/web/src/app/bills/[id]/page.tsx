"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Nav from "@/components/Nav";

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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/bills/${id}`);
        const json = (await res.json().catch(() => null)) as BillDetail & { error?: string };
        if (cancelled) return;
        if (!res.ok || !json.bill) {
          setError(json.error ?? "No bill with that id.");
          return;
        }
        setData(json);
      } catch {
        if (!cancelled) setError("Could not load the bill — check your connection and try again.");
      }
    }
    async function loadChain() {
      try {
        const res = await fetch("/api/chain");
        const json = (await res.json().catch(() => null)) as { agentWallet?: string };
        if (!cancelled && json.agentWallet) setAgentWallet(json.agentWallet);
      } catch {
        // The funding address is a nice-to-have here; the bill still loads without it.
      }
    }
    load();
    loadChain();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  const bill = data?.bill;
  const statusWords: Record<string, string> = {
    created: "We have your bill. The next check runs every few minutes — it looks at the rate and at the USDT in the agent wallet.",
    watching: bill?.note ?? "Watching the rate. Nothing has moved yet.",
    converting: "The money is being changed and paid — the cNGN is on its way to your supplier.",
    paid: "Paid. Your supplier has the cNGN.",
    failed: bill?.note ?? "Something went wrong — nothing was paid. The receipt below says what happened.",
  };

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96, maxWidth: 820 }}>
        <a href="/bills" style={{ fontSize: 14, color: "var(--muted)" }}>← Back to naira bills</a>
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
              {bill.fundingNeededUsdt && bill.fundingReady === false && (
                <p>
                  <b>To pay this bill we need about ${Number(bill.fundingNeededUsdt).toFixed(2)} USDT in the agent wallet.</b>{" "}
                  {agentWallet ? (
                    <>
                      Send it to{" "}
                      <a href={`${bill.explorerUrl}/address/${agentWallet}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>
                        {shortAddress(agentWallet)} ↗
                      </a>{" "}
                      and we will change it and pay your supplier. Nothing moves until then.
                    </>
                  ) : (
                    "We will show you where to send it — the page is still loading that part."
                  )}
                </p>
              )}
              {bill.fundingReady === true && bill.status !== "paid" && (
                <p><b>The USDT is in the agent wallet</b> — we are watching the rate.</p>
              )}
            </div>

            {(bill.approvalTxHashes.length > 0 || bill.swapTxHash || bill.payoutTxHash) && (
              <div style={{ marginTop: 24 }}>
                <h2 style={{ fontSize: 20 }}>On the chain</h2>
                <div className="card pad" style={{ marginTop: 12, display: "grid", gap: 12 }}>
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
