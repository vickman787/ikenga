"use client";
import { useEffect, useState } from "react";
import { JOB_LABELS, type JobType } from "@ikenga/shared";
import WalletGate from "@/components/WalletGate";
interface MyJob { id: string; jobType: JobType; status: string; createdAt: string; payCurrency?: string; priceAtomic?: string; priceUsdc: number }
const statusLabels: Record<string,string> = { draft: "Awaiting payment", escrowed: "In escrow", "in-progress": "In progress", delivered: "Ready to review", accepted: "Accepted", rejected: "Rejected", refunded: "Refunded" };
function MyJobs() {
  const [jobs, setJobs] = useState<MyJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch("/api/jobs", { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load your jobs.");
      setJobs([...data.jobs].sort((a: MyJob,b: MyJob) => b.createdAt.localeCompare(a.createdAt)));
    }).catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [attempt]);
  const filtered = jobs?.filter(job => [JOB_LABELS[job.jobType], statusLabels[job.status] ?? job.status, job.payCurrency ?? "USDT", job.id].join(" ").toLowerCase().includes(query.toLowerCase()));
  return <main className="wrap" style={{ paddingTop: 32, paddingBottom: 80, maxWidth: 1000 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20, flexWrap: "wrap" }}><div><h1 style={{ fontSize: 36 }}>My jobs</h1><p style={{ marginTop: 10, color: "var(--muted)" }}>Your briefs, progress, and finished work. Both USDT and cNGN jobs are included.</p></div><a href="/#hire" className="btn">New job</a></div><label style={{ display: "grid", gap: 8, marginBlock: 28 }}>Search your jobs<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Service, status, currency, or job ID" /></label>{error ? <div className="card pad" role="alert"><p>{error}</p><button className="btn secondary" onClick={() => setAttempt(value => value + 1)} type="button">Try again</button></div> : jobs === null ? <p role="status">Loading your jobs…</p> : jobs.length === 0 ? <div className="card pad"><h2>No jobs for this wallet yet.</h2><p style={{ marginTop: 12 }}>If you ordered with a different wallet, sign out and connect that wallet. Your existing jobs stay with the wallet that created them.</p><p style={{ marginTop: 16 }}><a href="/#hire">Start your first job</a></p></div> : filtered?.length === 0 ? <p>No jobs match your search.</p> : <div style={{ display: "grid", gap: 14 }}>{filtered?.map(job => <article className="card pad" key={job.id} style={{ display: "flex", gap: 20, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}><div><h2 style={{ fontSize: 20 }}><a href={"/jobs/" + job.id}>{JOB_LABELS[job.jobType]}</a></h2><p style={{ marginTop: 8, color: "var(--muted)", overflowWrap: "anywhere" }}>{job.id} · {new Date(job.createdAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}</p><p style={{ marginTop: 8 }}>{statusLabels[job.status] ?? job.status} · {job.payCurrency === "cNGN" && job.priceAtomic ? (Number(job.priceAtomic) / 1_000_000).toLocaleString("en-NG", {maximumFractionDigits: 6}) + " cNGN" : (job.priceUsdc ?? 1) + " " + (job.payCurrency ?? "USDT")}</p></div><a href={"/jobs/" + job.id}>Open job →</a></article>)}</div>}</main>;
}
export default function MyJobsPage() { return <WalletGate><MyJobs /></WalletGate>; }
