"use client";
import { useEffect, useState } from "react";
import "./activity.css";
interface Activity { summary: {jobs: number; done: number; settled: number; customers: number}; verify: {ok: boolean}; onchainDecisions: number }
export default function ActivityPage() {
  const [data, setData] = useState<Activity | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null);
    fetch("/api/cfo", {cache:"no-store",signal:controller.signal}).then(async response => {
      const value = await response.json();
      if (!response.ok || !value.summary || ![value.summary.jobs,value.summary.done,value.summary.settled,value.summary.customers].every(v => typeof v === "number" && Number.isFinite(v)) || typeof value.verify?.ok !== "boolean") throw new Error("Activity figures are unavailable right now. Please try again.");
      if (!controller.signal.aborted) {setData(value);setCheckedAt(new Date().toLocaleTimeString("en-NG",{hour:"2-digit",minute:"2-digit"}));}
    }).catch(() => {if (!controller.signal.aborted) setError("Activity figures are unavailable right now. Please try again.");}).finally(() => {if (!controller.signal.aborted) setBusy(false);});
    return () => controller.abort();
  },[refresh]);
  return <div className="activity-page">
    <a className="activity-skip" href="#activity-main">Skip to content</a>
    <header className="activity-header"><a className="activity-brand" href="/" aria-label="Ikenga home"><img src="/logo-mark.png" width="36" height="36" alt="" /><span>ikenga</span></a><nav aria-label="Activity navigation"><a href="/jobs">My jobs</a><a className="btn primary" href="/#hire">New job</a></nav></header>
    <main id="activity-main" className="activity-main">
      <div className="activity-heading"><div><span className="activity-eyebrow">ACTIVITY & TRANSPARENCY</span><h1>Work you can count on.</h1><p>A clear view of customer activity, escrow, and the records behind the work.</p></div><button className="btn secondary" type="button" onClick={() => setRefresh(value => value + 1)} disabled={busy}>{busy ? "Checking…" : "Refresh figures"}</button></div>
      {error && <div className="activity-error" role="alert"><p>{error}</p>{data && <p>The figures below are from the last successful check.</p>}</div>}
      <section className="activity-metrics" aria-label="Customer activity totals" aria-busy={busy}>{([{label:"Customer jobs",value:data?.summary.jobs},{label:"Jobs delivered",value:data?.summary.done},{label:"Jobs accepted",value:data?.summary.settled},{label:"Customer wallets",value:data?.summary.customers}]).map(metric => <div className="activity-metric" key={metric.label}><strong>{metric.value === undefined ? "—" : metric.value.toLocaleString("en-NG")}</strong><span>{metric.label}</span></div>)}</section>
      <p className="activity-caption" role="status">{busy ? "Checking the latest figures…" : checkedAt ? "Last checked at " + checkedAt + ". " : ""}Totals cover real customer activity and exclude test runs.</p>
      <div className="activity-grid">
        <section id="audit" className="activity-card"><span className="activity-eyebrow">THE RECORD BEHIND THE WORK</span><h2>Audit integrity</h2><span className={"activity-status" + (data ? data.verify.ok ? " is-ok" : " needs-review" : "")}>{data ? data.verify.ok ? "Checks passed" : "Needs review" : busy ? "Checking records…" : "Unavailable"}</span><p>This checks that recorded decisions still match their hash chain. Each customer can see their own job’s detailed activity after signing in.</p><a className="activity-link" href="/jobs">View your jobs →</a></section>
        <section className="activity-card"><span className="activity-eyebrow">YOUR MONEY HAS A WAITING ROOM</span><h2>Escrow, in plain words.</h2><p>Your job’s payment stays in its escrow contract while the team works. Acceptance, rejection, and deadline release follow the existing contract rules.</p><p>USDT and cNGN have separate treasury vaults. You can see both currency balances on the overview.</p><a className="activity-link" href="/#money">Explore the treasury →</a></section>
      </div>
      <section className="activity-privacy"><div><span className="activity-eyebrow">PUBLIC TOTALS. YOUR OWN WORKSPACE.</span><h2>Your work stays with your wallet.</h2><p>Customer briefs, wallet addresses, and finished work are not listed on this public page. Sign in with the wallet you used to order to revisit your USDT and cNGN jobs.</p><p>Blockchain transactions and any work you choose to publish remain public.</p></div><a className="btn primary" href="/jobs">Open My jobs</a></section>
    </main><footer className="activity-footer"><a href="/">Back to Ikenga</a><span>Good work. A clear record.</span></footer>
  </div>;
}
