"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Nav from "@/components/Nav";
import BillFaq from "@/components/BillFaq";
import { MAX_BILL_NGN, MIN_BILL_NGN, MAX_DEADLINE_DAYS } from "@/lib/billConstants";
import "./bills.css";

type Quote = { amountNgn: number; rate: number; neededUsdt: string; minimumRate: number; checkedAt: string; expiresAt: string };
const money = (n: number, digits = 2) => n.toLocaleString("en-NG", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export default function BillsPage() {
  const router = useRouter();
  const [payerName, setPayerName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [amountNgn, setAmountNgn] = useState("");
  const [supplierWallet, setSupplierWallet] = useState("");
  const [deadline, setDeadline] = useState("");
  const [minRate, setMinRate] = useState("");
  const [rateMode, setRateMode] = useState<"current" | "target">("current");
  const [deadlinePolicy, setDeadlinePolicy] = useState<"pay_at_deadline" | "keep_waiting">("keep_waiting");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [budget, setBudget] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const amount = Number(amountNgn);
  const matchingQuote = quote?.amountNgn === amount ? quote : null;
  const fresh = matchingQuote !== null && now < Date.parse(matchingQuote.expiresAt);
  const selectedMinimum = rateMode === "current" ? matchingQuote?.minimumRate : Number(minRate);
  const estimatedUsdt = rateMode === "target" && Number(minRate) > 0 ? amount / Number(minRate) : null;
  const difference = matchingQuote && budget !== "" ? Number(budget) - Number(matchingQuote.neededUsdt) : null;

  async function refreshQuote() {
    setQuoting(true); setQuoteError(""); setQuote(null);
    try {
      const res = await fetch('/api/bills/quote?amountNgn=' + amount, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not get a live quote.");
      setQuote(json as Quote); setNow(Date.now());
    } catch (err) { setQuoteError(err instanceof Error ? err.message : "Could not get a quote."); }
    finally { setQuoting(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError("");
    if (rateMode === "current" && !fresh) { setError("Refresh the live quote before continuing."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/bills", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ payerName, purpose, amountNgn: amount, supplierWallet,
          deadline: deadline ? new Date(deadline).toISOString() : "",
          minRate: selectedMinimum, rateMode, deadlinePolicy }),
      });
      const json = await res.json();
      if (!res.ok || !json.bill) throw new Error(json.error ?? "Could not save the bill.");
      router.push('/bills/' + json.bill.id);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save the bill."); setBusy(false); }
  }
  return <><Nav /><main className="wrap bill-flow">
    <a href="/">← Back to Ikenga</a>
    <div style={{ marginTop: 26 }}><span className="chip live"><span className="dot" /> Ikenga Pay</span></div>
    <h1>Your bill. Your rate. Your timing.</h1>
    <p className="bill-intro">Fund with USDT on Celo. Choose a current quote or wait for your target rate, and your supplier receives the agreed amount in cNGN.</p>
    <p style={{ marginTop: 18 }}><a href="/bills/history" className="btn secondary">My bill history →</a> <a href="#bill-faq" style={{ marginLeft: 18 }}>How it works ↓</a></p>
    <form onSubmit={submit} className="card pad bill-form">
      <fieldset><legend>1. Set the supplier’s bill</legend><div className="bill-fields">
        <label className="field">Your name<input value={payerName} onChange={e => setPayerName(e.target.value)} required maxLength={100} placeholder="e.g. Ada" /></label>
        <label className="field">What is the bill for?<input value={purpose} onChange={e => setPurpose(e.target.value)} required maxLength={200} placeholder="e.g. Rice for the shop" /></label>
        <label className="field">Supplier receives (cNGN)<span className="hint">Whole naira: ₦{MIN_BILL_NGN.toLocaleString("en-NG")}–₦{MAX_BILL_NGN.toLocaleString("en-NG")}. 1 cNGN represents ₦1.</span><input type="number" inputMode="numeric" min={MIN_BILL_NGN} max={MAX_BILL_NGN} step="1" value={amountNgn} onChange={e => { setAmountNgn(e.target.value); setQuoteError(""); }} required placeholder="e.g. 5000" /></label>
        <label className="field">Supplier’s Celo wallet<span className="hint">The supplier receives cNGN in this wallet. This does not pay a bank account or utility company directly.</span><input value={supplierWallet} onChange={e => setSupplierWallet(e.target.value)} required pattern="^0x[0-9a-fA-F]{40}$" placeholder="0x…" className="mono" /></label>
      </div></fieldset>
      <fieldset><legend>2. Choose your exchange rate</legend><div className="bill-options">
        <label className={'bill-choice ' + (rateMode === "current" ? "selected" : "")}><input type="radio" name="rateMode" value="current" checked={rateMode === "current"} onChange={() => setRateMode("current")} /><span><b>Use the current rate</b><small>Start from a live quote with a 0.5% movement allowance. The worker checks bills every few minutes; this does not reserve the quote or guarantee an instant payout.</small></span></label>
        <label className={'bill-choice ' + (rateMode === "target" ? "selected" : "")}><input type="radio" name="rateMode" value="target" checked={rateMode === "target"} onChange={() => setRateMode("target")} /><span><b>Wait for my target rate</b><small>Choose the minimum cNGN per USDT you want the worker to accept.</small></span></label>
      </div>
      {rateMode === "target" && <label className="field">My minimum rate (cNGN per 1 USDT)<input type="number" inputMode="decimal" min="0.000001" max="100000" step="any" value={minRate} onChange={e => setMinRate(e.target.value)} required placeholder="e.g. 1450" /><span className="hint">A higher rate means less USDT for the same bill. The target may never be reached.</span></label>}
      <div className="bill-quote" style={{ marginTop: 18 }}>
        <button className="btn secondary" type="button" onClick={refreshQuote} disabled={quoting || !Number.isInteger(amount) || amount < MIN_BILL_NGN || amount > MAX_BILL_NGN}>{quoting ? "Checking Textile FX…" : "Get / refresh live quote"}</button>
        {quoteError && <p role="alert" className="error">{quoteError}</p>}
        {matchingQuote && <>
          <p><strong>{matchingQuote.neededUsdt} USDT</strong><br />Estimated cost for {money(amount, 0)} cNGN</p>
          <p>Live rate: ₦{money(matchingQuote.rate)} per 1 USDT · conversion fee included; network gas separate.</p>
          <p role="status">{fresh ? 'Preview valid for ' + Math.max(0, Math.ceil((Date.parse(matchingQuote.expiresAt) - now) / 1000)) + ' seconds.' : "Preview expired. Refresh to use the current rate."}</p>
          {rateMode === "current" && <p><b>Minimum accepted rate: ₦{money(matchingQuote.minimumRate, 6)} per USDT.</b> Up to 0.5% below this preview. A worse firm rate waits under your deadline rule.</p>}
          <label className="field">Compare my USDT budget (optional)<input type="number" inputMode="decimal" min="0" step="0.000001" value={budget} onChange={e => setBudget(e.target.value)} placeholder={matchingQuote.neededUsdt} /></label>
          {difference !== null && <p aria-live="polite">{!fresh ? "Refresh the quote to compare your budget with the latest rate. " : ""}{Math.abs(difference) < 0.000001 ? "Your budget matches this preview." : difference < 0 ? 'Increase by ' + money(-difference, 6) + ' USDT to cover this preview.' : 'Reduce by ' + money(difference, 6) + ' USDT to match this preview.'} Estimated value: {money(Number(budget) * matchingQuote.rate)} cNGN. The supplier’s bill stays at {money(amount, 0)} cNGN.</p>}
        </>}
        {estimatedUsdt !== null && amount > 0 && <p>At your target: about <b>{money(estimatedUsdt, 6)} USDT</b>. This is an estimate; a live quote is required before conversion.</p>}
        <p className="bill-disclosure">This is a preview, not a reserved rate. Funding and worker processing take time; refresh before continuing. No funds move on this form.</p>
      </div></fieldset>
      <fieldset><legend>3. Decide what happens when it’s due</legend><div className="bill-fields">
        <label className="field">Due date and time (your local time)<input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} required /><span className="hint">Choose a future time within {MAX_DEADLINE_DAYS} days. Payments depend on worker checks and quote availability.</span></label>
        <label className={'bill-choice ' + (deadlinePolicy === "keep_waiting" ? "selected" : "")}><input type="radio" name="deadlinePolicy" checked={deadlinePolicy === "keep_waiting"} onChange={() => setDeadlinePolicy("keep_waiting")} /><span><b>Keep waiting for my minimum rate</b><small>Protect the minimum even after the due date. The supplier may be paid late, or the target may never be reached. Funds remain in the agent wallet while waiting.</small></span></label>
        <label className={'bill-choice ' + (deadlinePolicy === "pay_at_deadline" ? "selected" : "")}><input type="radio" name="deadlinePolicy" checked={deadlinePolicy === "pay_at_deadline"} onChange={() => setDeadlinePolicy("pay_at_deadline")} /><span><b>Pay at the available rate when due</b><small>I allow conversion below my minimum after the due time. More USDT may be needed; payment still requires funding, liquidity, gas and a valid quote.</small></span></label>
      </div></fieldset>
      <div className="bill-review">
        <p><b>Before you continue:</b> supplier receives {amount > 0 ? money(amount, 0) : "your entered amount in"} cNGN. {selectedMinimum ? 'Minimum rate: ₦' + money(selectedMinimum, 6) + ' per USDT. ' : ""}{deadlinePolicy === "keep_waiting" ? "Your minimum stays protected after the due date." : "You allow a lower rate after the due date."}</p>
        <p className="bill-disclosure">Funding goes to an operator-controlled wallet, separately from job escrow. After your wallet confirms funding, the worker checks about every five minutes. It uses a fresh firm quote and waits if the rate is below your displayed minimum (or follows your deadline rule). The preview is not reserved. Unused USDT is not automatically refunded. Bill detail links are accessible to anyone with the link; avoid sensitive information.</p>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="btn leaf lg block" type="submit" disabled={busy || (rateMode === "current" && !fresh)}>{busy ? "Saving your bill…" : "Create bill & review funding →"}</button>
        <p className="note">You will review and sign the USDT funding transaction on the next page.</p>
      </div>
    </form><BillFaq />
  </main></>;
}
