"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JOB_LABELS, type JobType } from "@ikenga/shared";

/**
 * Job page — a hired job gets its own page, where you can watch the team
 * work, step by step. It reads the real /api/jobs/[id] record: the $1
 * quote, the bond the CFO puts up, and the decisions the CFO made. No
 * money moves here yet — escrow is not switched on, and the page says so
 * in plain words.
 */
interface JobDetail {
  job: {
    id: string;
    jobType: JobType;
    description: string;
    customerWallet: string;
    status: string;
    priceUsdc: number;
    bondUsdc: number;
    cfoAccepted: boolean;
    cfoReason: string;
    decisionHash: string;
    createdAt: string;
  };
  decisions: { id: string; kind: string; reason: string; hash: string; createdAt: string }[];
  verify: { ok: boolean };
  fxSwaps: unknown[];
  reconciliation: { settled: number; unresolved: number; failed: number };
}

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/jobs/${id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Job not found");
        setData(d);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  return (
    <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96, maxWidth: 820 }}>
      <a href="/#hire" style={{ fontSize: 14, color: "var(--muted)" }}>← Back to Ikenga</a>
      {error && (
        <div className="card pad" style={{ marginTop: 24 }}>
          <h1 style={{ fontSize: 28 }}>Job not found</h1>
          <p style={{ marginTop: 8, color: "var(--ink-2)" }}>{error}</p>
          <p style={{ marginTop: 8, color: "var(--ink-2)" }}>
            Jobs are saved on this site for now, so a job made before the
            site was updated may be gone.
          </p>
        </div>
      )}
      {!error && !data && <p style={{ marginTop: 24, color: "var(--muted)" }}>Loading your job…</p>}
      {data && (
        <>
          <span className="chip live" style={{ marginTop: 24 }}>
            <span className="dot" /> {data.job.status}
          </span>
          <h1 style={{ fontSize: 36, marginTop: 14 }}>{JOB_LABELS[data.job.jobType]}</h1>
          <p style={{ marginTop: 10, fontSize: "var(--lede)", color: "var(--ink-2)", lineHeight: 1.6 }}>
            {data.job.description}
          </p>
          <div className="card pad" style={{ marginTop: 24, display: "grid", gap: 12 }}>
            <p><b>Price:</b> ${data.job.priceUsdc} · <b>Bond the CFO puts up:</b> ${data.job.bondUsdc}</p>
            <p><b>Paying wallet:</b> <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>{data.job.customerWallet}</span></p>
            <p><b>The CFO says:</b> {data.job.cfoReason}</p>
            <p className="mono" style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
              The CFO&apos;s decision, written down: {data.job.decisionHash}
            </p>
            <p><b>The money log:</b> {data.verify.ok ? "✓ checks out" : "✕ doesn&apos;t check out"}</p>
            <p><b>Tool payments:</b> {data.reconciliation.settled} settled · {data.reconciliation.unresolved} waiting · {data.reconciliation.failed} failed</p>
            <p><b>Money changed to naira:</b> {data.fxSwaps.length} {data.fxSwaps.length === 1 ? "swap" : "swaps"} so far</p>
          </div>
          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 20 }}>CFO decisions</h2>
            {data.decisions.length === 0 && (
              <p style={{ marginTop: 8, color: "var(--ink-2)" }}>No decisions recorded for this job yet.</p>
            )}
            {data.decisions.map((d) => (
              <div key={d.id} className="card pad" style={{ marginTop: 12 }}>
                <p><b>{d.kind}</b></p>
                <p style={{ marginTop: 4, color: "var(--ink-2)" }}>{d.reason}</p>
                <p className="mono" style={{ marginTop: 8, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>{d.hash}</p>
              </div>
            ))}
          </div>
          <p className="note" style={{ marginTop: 24 }}>
            No money has moved on this job yet. The escrow and vault are
            built but not switched on, so this is a price and a written
            record — not money in escrow.
          </p>
        </>
      )}
    </main>
  );
}
