"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { JOB_LABELS, type JobType } from "@ikenga/shared";

/**
 * Job page — Syncly's promise is "watch the team work, live, step by step,
 * on your job page", so a hired job gets one. It reads the real
 * /api/jobs/[id] record: the $1 quote, the CFO bond and decision, the
 * hash-chain verification, and the FX / reconciliation state. No money
 * moves here — escrow is not deployed yet, and the page says so.
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
            Jobs on this server live in memory only, so a job created before a redeploy is gone.
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
            <p><b>Price:</b> ${data.job.priceUsdc} · <b>CFO bond:</b> ${data.job.bondUsdc}</p>
            <p><b>Paying wallet:</b> <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>{data.job.customerWallet}</span></p>
            <p><b>CFO:</b> {data.job.cfoReason}</p>
            <p className="mono" style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
              Decision hash: {data.job.decisionHash}
            </p>
            <p><b>Hash chain:</b> {data.verify.ok ? "✓ verified" : "✕ not verified"}</p>
            <p><b>Tool payments settled:</b> {data.reconciliation.settled} · unresolved: {data.reconciliation.unresolved} · failed: {data.reconciliation.failed}</p>
            <p><b>FX swaps:</b> {data.fxSwaps.length}</p>
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
            No money moves yet — the escrow and vault contracts are written
            but not deployed, so this job is a priced, recorded quote in the
            hash-chained ledger, not a funded escrow.
          </p>
        </>
      )}
    </main>
  );
}
