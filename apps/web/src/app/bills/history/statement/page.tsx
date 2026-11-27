"use client";

import { useEffect, useState } from "react";
import WalletGate from "@/components/WalletGate";
import { formatUsdtDollars } from "@/lib/usdt";
import "./statement.css";

type Activity = {
  id: string; billId: string; purpose: string; amountNgn: number; supplierWallet: string;
  kind: string; reason: string; txHash: string | null; rateSeen: number | null;
  fundingUsdtAtomic: string | null; createdAt: string;
};
type StatementData = {
  wallet: string; from: string; to: string; generatedAt: string;
  activity: Activity[]; totals: { fundedUsdtAtomic: string; paidNgn: number; eventCount: number };
};
const labels: Record<string, string> = {
  created: "Bill created", funded: "USDT funding verified", quote: "Rate quote",
  refuse: "Rate guard", convert: "Conversion approved", swap: "USDT to cNGN swap",
  payout: "Supplier payout", paid: "Payment completed", failed: "Payment failed",
  waiting: "Waiting", checked: "On-chain check",
};
const short = (value: string) => value.slice(0, 8) + "…" + value.slice(-6);
const date = (value: string) => new Date(value).toLocaleString("en-NG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Lagos" });
function Statement() {
  const [data, setData] = useState<StatementData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState({ from: "", to: "" });
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const from = query.get("from") ?? "";
    const to = query.get("to") ?? "";
    setRange({ from, to });
    const controller = new AbortController();
    fetch("/api/bills/history/statement?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to), { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Could not prepare this statement.");
        setData(json as StatementData);
      })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not prepare this statement."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <main className="statement-wrap">
    <div className="statement-tools no-print">
      <a href="/bills/history">← Back to bill history</a>
      <button className="btn leaf" type="button" onClick={() => window.print()} disabled={!data || loading}>Download / print PDF</button>
      <p>In the print window, choose “Save as PDF”.</p>
    </div>
    {loading ? <p role="status" className="no-print">Preparing your private statement…</p> : error ? <p role="alert" className="no-print">{error}</p> : data && <>
      <header className="statement-header">
        <div className="statement-brand"><img src="/logo-mark.png" alt="" /><div><strong>IKENGA</strong><span>IKENGA PAY</span></div></div>
        <div className="statement-title"><span>WALLET ACTIVITY</span><h1>Bill statement</h1><p>{range.from} to {range.to}</p></div>
      </header>
      <section className="statement-account">
        <div><span>FUNDED BY WALLET</span><code>{data.wallet}</code></div>
        <div><span>STATEMENT PERIOD (WAT)</span><strong>{range.from} – {range.to}</strong></div>
        <div><span>GENERATED</span><strong>{date(data.generatedAt)} WAT</strong></div>
      </section>
      <section className="statement-summary">
        <div><span>VERIFIED FUNDING</span><strong>{formatUsdtDollars(BigInt(data.totals.fundedUsdtAtomic))} USDT</strong></div>
        <div><span>SUPPLIER PAYOUTS (cNGN)</span><strong>cNGN {data.totals.paidNgn.toLocaleString("en-NG")}</strong></div>
        <div><span>RECORDED EVENTS</span><strong>{data.totals.eventCount}</strong></div>
      </section>
      {data.activity.length ? <table className="statement-table">
        <thead><tr><th>Date (WAT)</th><th>Activity</th><th>Bill</th><th>Amount</th><th>Transaction</th></tr></thead>
        <tbody>{data.activity.map(item => <tr key={item.id}>
          <td>{date(item.createdAt)}</td>
          <td><strong>{labels[item.kind] ?? item.kind}</strong><small>{item.reason}</small></td>
          <td><span>{item.purpose}</span><small>{short(item.billId)}</small></td>
          <td>{item.fundingUsdtAtomic ? "+" + formatUsdtDollars(BigInt(item.fundingUsdtAtomic)) + " USDT" : item.kind === "payout" ? "cNGN " + item.amountNgn.toLocaleString("en-NG") : "—"}</td>
          <td>{item.txHash ? <a href={"https://celoscan.io/tx/" + item.txHash}>{short(item.txHash)}</a> : "—"}</td>
        </tr>)}</tbody>
      </table> : <p className="statement-empty">No recorded bill activity for this wallet in the selected period.</p>}
      <footer className="statement-footer">
        <strong>Ikenga Pay activity statement</strong>
        <p>This report summarizes verified bill-funding transfers and recorded bill receipts for the wallet above. It is not a bank statement, bank account, or account-balance record. It does not include activity funded by another wallet.</p>
        <p>Transaction links open CeloScan. Amounts reflect on-chain records where a transaction reference is shown.</p>
      </footer>
    </>}
  </main>;
}
export default function BillStatementPage() {
  return <WalletGate title="Your bill statement." description="Sign in with the wallet that funded these bills to prepare its private activity statement." walletHint="Each wallet has its own bill statement."><Statement /></WalletGate>;
}