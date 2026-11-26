"use client";
import { useEffect, useState } from "react";
import WalletGate from "@/components/WalletGate";
import { formatUsdtDollars } from "@/lib/usdt";
import "./history.css";

interface BillHistoryItem {
  id: string; purpose: string; amountNgn: number;
  status: "created" | "watching" | "converting" | "paid" | "failed";
  createdAt: string; deadline: string; supplierWallet: string;
  fundingPaidUsdtAtomic: string | null;
}
const STATUS_LABELS = { created: "Created", watching: "Watching the rate", converting: "Processing payment", paid: "Supplier paid", failed: "Failed" };
const FILTERS = [{ value: "all", label: "All bills" }, { value: "active", label: "In progress" }, { value: "paid", label: "Paid" }, { value: "failed", label: "Failed" }] as const;
type Filter = (typeof FILTERS)[number]["value"];
const date = (value: string) => new Date(value).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
function BillHistory() {
  const [bills, setBills] = useState<BillHistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    async function load() {
      try {
        const response = await fetch("/api/bills/history", { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load your bill history.");
        if (!Array.isArray(data.bills)) throw new Error("Could not load your bill history.");
        if (!controller.signal.aborted) setBills(data.bills);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load your bill history.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);
  const filtered = bills?.filter(bill => {
    const matchesStatus = filter === "all" || (filter === "active" ? ["created", "watching", "converting"].includes(bill.status) : bill.status === filter);
    return matchesStatus && [bill.purpose, bill.id, bill.supplierWallet, STATUS_LABELS[bill.status]].join(" ").toLowerCase().includes(query.trim().toLowerCase());
  });
  const inProgress = bills?.filter(bill => ["created", "watching", "converting"].includes(bill.status)).length;
  const paid = bills?.filter(bill => bill.status === "paid").length;
  return <main className="wrap bh-page">
    <header className="bh-heading"><div><span className="bh-eyebrow">YOUR PAYMENTS, IN ONE PLACE</span><h1>My bill history</h1><p>Bills funded by this wallet, from rate watching to supplier payment.</p></div><div className="bh-actions"><button className="btn secondary" type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>{loading ? "Checking…" : "Refresh"}</button><a className="btn primary" href="/bills">New bill</a></div></header>
    <section className="bh-summary" aria-label="Bill totals"><div><strong>{bills?.length ?? "—"}</strong><span>Funded bills</span></div><div><strong>{inProgress ?? "—"}</strong><span>In progress</span></div><div><strong>{paid ?? "—"}</strong><span>Suppliers paid</span></div></section>
    <p className="bh-note">Use the wallet that paid for the bill. Unpaid bills are not linked to a wallet yet; keep their original bill link.</p>
    <div className="bh-controls"><label>Search your bills<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Purpose, supplier wallet, or bill ID" /></label><label>Status<select value={filter} onChange={event => setFilter(event.target.value as Filter)}>{FILTERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
    {error ? <div className="card pad" role="alert"><p>{error}</p><button className="btn secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : loading ? <p role="status">Loading your bill history…</p> : bills?.length === 0 ? <div className="card pad bh-empty"><h2>No funded bills for this wallet yet.</h2><p>If you used another wallet, sign out and connect that wallet. Existing bills appear automatically once their funding payment is recorded.</p><a className="btn primary" href="/bills">Pay a naira bill</a></div> : filtered?.length === 0 ? <p role="status">No bills match your search.</p> : <div className="bh-list">{filtered?.map(bill => <article className="card pad bh-bill" key={bill.id}><div className="bh-bill-main"><span className={"bh-status bh-status--" + bill.status}>{STATUS_LABELS[bill.status]}</span><h2><a href={"/bills/" + bill.id}>{bill.purpose}</a></h2><p className="bh-date">Created {date(bill.createdAt)} · Due {date(bill.deadline)}</p><p className="bh-supplier">Supplier <span title={bill.supplierWallet}>{bill.supplierWallet.slice(0, 6)}…{bill.supplierWallet.slice(-4)}</span></p></div><div className="bh-bill-amount"><strong>₦{bill.amountNgn.toLocaleString("en-NG")}</strong><span>{bill.fundingPaidUsdtAtomic ? formatUsdtDollars(BigInt(bill.fundingPaidUsdtAtomic)) + " USDT funded" : "Funding recorded"}</span><a href={"/bills/" + bill.id}>View bill & receipts →</a></div></article>)}</div>}
  </main>;
}
export default function BillHistoryPage() {
  return <WalletGate title="Your bills, with your wallet." description="Sign in with the wallet you used to fund your bills to see their history, payment progress, and receipts." walletHint="Used more than one wallet? Sign in with each wallet to see the bills it funded."><BillHistory /></WalletGate>;
}

