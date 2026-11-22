"use client";

import { useState } from "react";
import { JOB_LABELS, JOB_TYPES, type JobType } from "@ikenga/shared";

interface HireResult {
  id: string;
  jobType: JobType;
  description: string;
  status: string;
  priceUsdc: number;
  bondUsdc: number;
  cfoAccepted: boolean;
  cfoReason: string;
  decisionHash: string;
}

export default function HireForm() {
  const [jobType, setJobType] = useState<JobType>("website");
  const [description, setDescription] = useState("");
  const [wallet, setWallet] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HireResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobType, description, customerWallet: wallet }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create the job");
      setResult(data.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the job");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card pad">
      <span className="chip live">
        <span className="dot" /> Hire Ikenga
      </span>
      <h2 style={{ fontSize: 24, marginTop: 14 }}>Every job costs $1.</h2>
      <p style={{ marginTop: 8, color: "var(--ink-2)", lineHeight: 1.6 }}>
        You pay into escrow and only pay if you accept the work. If you reject
        it, you are refunded — plus a bond the CFO puts up.
      </p>

      <form onSubmit={submit} style={{ marginTop: 24, display: "grid", gap: 20 }}>
        <div>
          <label className="field">
            What do you need done?
            <span className="hint">Pick a job — every job is $1.</span>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            {JOB_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setJobType(t)}
                className={`job-pick ${jobType === t ? "on" : ""}`}
              >
                {JOB_LABELS[t]} <span className="price">· $1</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="description" className="field">
            Describe the job
            <span className="hint">Say what you need in a sentence.</span>
          </label>
          <input
            id="description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A one-page website for my bakery in Yaba"
            style={{ marginTop: 10 }}
          />
        </div>

        <div>
          <label htmlFor="wallet" className="field">
            Your Celo wallet address
            <span className="hint">Only the paying wallet can accept or reject the work.</span>
          </label>
          <input
            id="wallet"
            type="text"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x…"
            style={{ marginTop: 10 }}
          />
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy} className="btn leaf lg block">
          {busy ? "Asking the CFO…" : "Hire Ikenga — $1"}
        </button>
        <p className="note" style={{ textAlign: "center" }}>
          Step 1 demo: your job is stored in this server&apos;s memory only. No
          money moves.
        </p>
      </form>

      {result && (
        <div
          style={{
            marginTop: 20,
            borderRadius: 12,
            border: "1px solid #cfe6bc",
            background: "var(--accent-soft)",
            padding: 16,
            fontSize: 14.5,
          }}
        >
          <p style={{ fontWeight: 700, color: "var(--accent-ink)" }}>
            Job created — {result.id}
          </p>
          <p style={{ marginTop: 6 }}>
            {JOB_LABELS[result.jobType]} · ${result.priceUsdc} · CFO bond $
            {result.bondUsdc}
          </p>
          <p style={{ marginTop: 6, color: "var(--ink-2)" }}>{result.cfoReason}</p>
          <p className="mono" style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
            CFO decision hash: {result.decisionHash}
          </p>
        </div>
      )}
    </div>
  );
}
