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
    <div className="rounded-2xl border border-[#f5c51833] bg-[#151524] p-6">
      <h2 className="text-xl font-bold">Hire Ikenga</h2>
      <p className="mt-1 text-sm text-[#9a9ab0]">
        Every job costs $1. You pay into escrow and only pay if you accept the work.
        If you reject it, you are refunded — plus a bond the CFO puts up.
      </p>

      <form onSubmit={submit} className="mt-5 space-y-4">
        <div>
          <label className="block text-sm font-semibold">What do you need done?</label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {JOB_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setJobType(t)}
                className={`rounded-lg border px-3 py-2 text-left text-sm ${
                  jobType === t
                    ? "border-[#f5c518] bg-[#f5c51822] text-[#f5c518]"
                    : "border-[#ffffff22] text-[#f8f7ff]"
                }`}
              >
                {JOB_LABELS[t]} · $1
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor="description" className="block text-sm font-semibold">Describe the job</label>
          <input
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A one-page website for my bakery in Yaba"
            className="mt-1 w-full rounded-lg border border-[#ffffff22] bg-[#0b0b14] px-3 py-2 text-sm outline-none focus:border-[#f5c518]"
          />
        </div>

        <div>
          <label htmlFor="wallet" className="block text-sm font-semibold">Your Celo wallet address</label>
          <input
            id="wallet"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            placeholder="0x…"
            className="mt-1 w-full rounded-lg border border-[#ffffff22] bg-[#0b0b14] px-3 py-2 text-sm outline-none focus:border-[#f5c518]"
          />
          <p className="mt-1 text-xs text-[#9a9ab0]">Only the paying wallet can accept or reject the work.</p>
        </div>

        {error && <p className="rounded-lg bg-[#ef444422] px-3 py-2 text-sm text-[#fca5a5]">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-[#f5c518] px-4 py-3 font-bold text-black disabled:opacity-50"
        >
          {busy ? "Asking the CFO…" : "Hire Ikenga — $1"}
        </button>
        <p className="text-center text-xs text-[#9a9ab0]">
          Step 1 demo: your job is stored in this server&apos;s memory only. No money moves.
        </p>
      </form>

      {result && (
        <div className="mt-5 rounded-lg border border-[#22c55e55] bg-[#22c55e11] p-4 text-sm">
          <p className="font-bold text-[#4ade80]">Job created — {result.id}</p>
          <p className="mt-1">
            {JOB_LABELS[result.jobType]} · ${result.priceUsdc} · CFO bond ${result.bondUsdc}
          </p>
          <p className="mt-1 text-[#9a9ab0]">{result.cfoReason}</p>
          <p className="mt-2 break-all text-xs text-[#9a9ab0]">
            CFO decision hash: {result.decisionHash}
          </p>
        </div>
      )}
    </div>
  );
}
