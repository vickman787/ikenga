"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import { MAX_BILL_NGN, MIN_BILL_NGN } from "@/lib/billConstants";

/**
 * Pay a naira bill — the form.
 *
 * One person owes a supplier in naira. They tell us who they are, what
 * the bill is for, how much, who gets paid, when it is due, and the
 * lowest rate per dollar they will accept. Ikenga then watches the rate,
 * changes USDT to cNGN on Celo, and pays the supplier in cNGN — only at
 * their rate or better, or at the deadline.
 *
 * Nothing is paid on this page. After the bill is sent, the bill page
 * shows exactly how much USDT the swap needs and where to send it; the
 * money only moves once that USDT is in the agent wallet.
 */
export default function BillsPage() {
  const router = useRouter();
  const [payerName, setPayerName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [amountNgn, setAmountNgn] = useState("");
  const [supplierWallet, setSupplierWallet] = useState("");
  const [deadline, setDeadline] = useState("");
  const [minRate, setMinRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/bills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          payerName,
          purpose,
          amountNgn: Number(amountNgn),
          supplierWallet,
          deadline: deadline ? new Date(`${deadline}T23:59:59`).toISOString() : "",
          minRate: Number(minRate),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { bill?: { id: string }; error?: string };
      if (!res.ok || !json.bill) throw new Error(json.error ?? "Could not save the bill — try again.");
      router.push(`/bills/${json.bill.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the bill — try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96, maxWidth: 820 }}>
        <a href="/" style={{ fontSize: 14, color: "var(--muted)" }}>← Back to Ikenga</a>
        <div style={{ marginTop: 24 }}>
          <span className="chip live">
            <span className="dot" /> Pay a naira bill
          </span>
        </div>
        <h1 style={{ fontSize: 36, marginTop: 14 }}>Pay a naira bill</h1>
        <p style={{ marginTop: 10, fontSize: "var(--lede)", color: "var(--ink-2)", lineHeight: 1.6 }}>
          You owe someone in naira. We change USDT to cNGN on Celo and pay them in cNGN — only at the rate
          you name, or better. If the rate never reaches yours, we wait until the day you pick, then pay
          anyway and show you exactly what the wait cost.
        </p>

        <form onSubmit={submit} className="card pad" style={{ marginTop: 24, display: "grid", gap: 16 }}>
          <label className="field">
            Your name
            <span className="hint">Who owes this bill? The supplier sees this name on the receipt.</span>
            <input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="e.g. Ada" required maxLength={100} />
          </label>

          <label className="field">
            What is the bill for?
            <span className="hint">A sentence, so everyone can see what the money was for.</span>
            <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Rice for the shop" required maxLength={200} />
          </label>

          <label className="field">
            How much, in naira?
            <span className="hint">
              Whole naira. The smallest bill that works is ₦{MIN_BILL_NGN.toLocaleString("en-NG")} — about $1,
              the lowest amount the exchange will change. The biggest is ₦{MAX_BILL_NGN.toLocaleString("en-NG")}.
            </span>
            <input
              value={amountNgn}
              onChange={(e) => setAmountNgn(e.target.value)}
              placeholder="e.g. 5000"
              inputMode="numeric"
              required
              min={MIN_BILL_NGN}
              max={MAX_BILL_NGN}
              type="number"
            />
          </label>

          <label className="field">
            The supplier&apos;s wallet
            <span className="hint">Their Celo wallet address (0x…). The cNGN goes straight there — not through us.</span>
            <input
              value={supplierWallet}
              onChange={(e) => setSupplierWallet(e.target.value)}
              placeholder="0x…"
              required
              pattern="^0x[0-9a-fA-F]{40}$"
              className="mono"
            />
          </label>

          <label className="field">
            When is it due?
            <span className="hint">The last day we can wait for your rate. After this day we pay anyway, at whatever the rate is.</span>
            <input value={deadline} onChange={(e) => setDeadline(e.target.value)} required type="date" />
          </label>

          <label className="field">
            The lowest rate you will accept, per dollar
            <span className="hint">
              Naira per $1. We checked ₦1,444 per $1 recently — check today&apos;s rate before you pick. We only
              change the money at this rate or better, until the due date.
            </span>
            <input
              value={minRate}
              onChange={(e) => setMinRate(e.target.value)}
              placeholder="e.g. 1444"
              inputMode="decimal"
              required
              min={1}
              step="any"
              type="number"
            />
          </label>

          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy} className="btn leaf lg block">
            {busy ? "Saving your bill…" : "Send the bill"}
          </button>
          <p className="note" style={{ textAlign: "center" }}>
            Nothing is paid here. The next page shows exactly how much USDT the swap needs and where to send
            it — the money only moves once that USDT is in the agent wallet.
          </p>
        </form>
      </main>
    </>
  );
}
