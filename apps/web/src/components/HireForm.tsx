"use client";

import { useEffect, useState } from "react";
import { JOB_LABELS, JOB_TYPES, type JobType } from "@ikenga/shared";
import {
  approveAndFund,
  connectInjected,
  deployEscrow,
  ensureChain,
  explorerTxUrl,
  fetchChainConfig,
  shortAddress,
  type Address,
  type ChainConfig,
} from "@/lib/contracts";

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

/** One example brief per job type, so the customer knows what to write. */
const DESCRIPTION_PLACEHOLDERS: Record<JobType, string> = {
  website: "e.g. A one-page website for my bakery in Yaba — bread, cakes and small chops, WhatsApp 0803…",
  "promo-video": "e.g. A short promo for my food stall in Lekki — jollof rice ₦2,500, small chops, WhatsApp 0803…",
  flyers: "e.g. A flyer for my salon in Ikeja — braids ₦15,000, cornrows ₦8,000, call 0805…",
  "market-report": "e.g. Compare payment options for my shop in Lagos — Paystack, Flutterwave, Moniepoint",
};

/**
 * The pay panel: $1 into the job's own escrow, from the customer's wallet.
 * Used here after a hire, and on the job page when a job is still waiting
 * to be paid for. Steps, in order: connect the wallet, set up the escrow,
 * approve $1, pay $1 in, save the payment. The work only starts once the
 * $1 is in escrow.
 */
export function PayPanel({
  jobId,
  description,
  customerWallet,
  account: initialAccount,
  onPaid,
}: {
  jobId: string;
  description: string;
  customerWallet: string;
  account: Address | null;
  onPaid?: () => void;
}) {
  const [account, setAccount] = useState<Address | null>(initialAccount);
  const [chain, setChain] = useState<ChainConfig | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [escrowAddress, setEscrowAddress] = useState<string | null>(null);
  const [deployTxHash, setDeployTxHash] = useState<string | null>(null);
  const [fundTxHash, setFundTxHash] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // The wallet can change outside this panel (the hire form's "Change
  // wallet" button) — keep the panel's copy in step with the prop.
  useEffect(() => {
    setAccount(initialAccount);
  }, [initialAccount]);

  async function connect() {
    setError(null);
    try {
      setAccount(await connectInjected());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your wallet did not connect.");
    }
  }

  async function pay() {
    setError(null);
    setBusy(true);
    try {
      // Always ask the wallet which account is selected right now — the
      // customer may have switched accounts since connecting.
      const acct = await connectInjected();
      setAccount(acct);
      if (acct.toLowerCase() !== customerWallet.toLowerCase()) {
        throw new Error(
          `That wallet (${shortAddress(acct)}) is not the wallet that ordered this job (${shortAddress(customerWallet)}). Connect the wallet that ordered it.`,
        );
      }
      const cfg = await fetchChainConfig();
      setChain(cfg);
      await ensureChain(cfg.chainId);

      // Reuse an escrow this panel already deployed, so a retry after a
      // failed save does not set up a second one.
      let esc = escrowAddress as Address | null;
      let deployHash = deployTxHash;
      if (!esc) {
        setProgress("Setting up your escrow…");
        const deployed = await deployEscrow({ account: acct, chain: cfg, description });
        esc = deployed.escrowAddress;
        deployHash = deployed.txHash;
        setEscrowAddress(esc);
        setDeployTxHash(deployHash);
        setProgress("Saving your escrow…");
        const res = await fetch(`/api/jobs/${jobId}/escrow`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ escrowAddress: esc, txHash: deployHash }),
        });
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          throw new Error(
            d.error ??
              "Could not save the escrow. Your escrow is set up on the chain — try paying again and it will be picked up.",
          );
        }
      }

      const { fundTxHash: fundHash } = await approveAndFund({
        account: acct,
        chain: cfg,
        escrowAddress: esc,
        onProgress: (s) =>
          setProgress(
            s === "approving" ? "Asking for $1 approval…" : "Paying $1 into escrow…",
          ),
      });
      setFundTxHash(fundHash);
      setProgress("Saving your payment…");
      const fundRes = await fetch(`/api/jobs/${jobId}/fund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: fundHash }),
      });
      const fundData = (await fundRes.json().catch(() => ({}))) as { error?: string };
      if (!fundRes.ok) {
        throw new Error(
          fundData.error ??
            "Your $1 is in escrow, but we could not save the payment. Tell us and we will sort it out.",
        );
      }
      setProgress(null);
      setDone(true);
      onPaid?.();
    } catch (err) {
      setProgress(null);
      setError(
        err instanceof Error
          ? err.message
          : "The payment did not go through. Nothing was taken — try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div
        style={{
          marginTop: 16,
          borderRadius: 12,
          border: "1px solid #cfe6bc",
          background: "var(--accent-soft)",
          padding: 16,
          fontSize: 14.5,
        }}
      >
        <p style={{ fontWeight: 700, color: "var(--accent-ink)" }}>
          Paid — your $1 is in escrow.
        </p>
        <p style={{ marginTop: 6, color: "var(--ink-2)" }}>
          The team can start now. If you turn the work down, the $1 comes
          back to your wallet.
        </p>
        {fundTxHash && chain && (
          <p style={{ marginTop: 8 }}>
            <a
              href={explorerTxUrl(chain, fundTxHash)}
              target="_blank"
              rel="noreferrer"
              className="mono"
              style={{ fontSize: 12, wordBreak: "break-all" }}
            >
              See the $1 payment on the chain →
            </a>
          </p>
        )}
        <p style={{ marginTop: 12 }}>
          <a href={`/jobs/${jobId}`} style={{ fontWeight: 700, color: "var(--accent-ink)" }}>
            Watch your job →
          </a>
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: 12,
        border: "1px solid var(--hatch-widget-border, #ddd6c4)",
        padding: 16,
        fontSize: 14.5,
      }}
    >
      <p style={{ fontWeight: 700 }}>Pay $1 into escrow</p>
      <p style={{ marginTop: 6, color: "var(--ink-2)", lineHeight: 1.6 }}>
        Your $1 sits in escrow until you accept the work. If you turn it
        down, it comes back to your wallet. You also pay the network fee in
        CELO — about 0.35 CELO in total for setting this up.
      </p>
      {!account ? (
        <button onClick={connect} className="btn leaf lg block" style={{ marginTop: 14 }} type="button">
          Connect your Celo wallet
        </button>
      ) : (
        <button onClick={pay} disabled={busy} className="btn leaf lg block" style={{ marginTop: 14 }} type="button">
          {busy ? (progress ?? "Working…") : "Pay $1 into escrow"}
        </button>
      )}
      {account && (
        <p className="mono" style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
          Paying from {account}
        </p>
      )}
      {deployTxHash && chain && (
        <p style={{ marginTop: 10 }}>
          <a
            href={explorerTxUrl(chain, deployTxHash)}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            Escrow set up — see it on the chain →
          </a>
        </p>
      )}
      {fundTxHash && chain && (
        <p style={{ marginTop: 6 }}>
          <a
            href={explorerTxUrl(chain, fundTxHash)}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 12, wordBreak: "break-all" }}
          >
            $1 paid — see it on the chain →
          </a>
        </p>
      )}
      {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
    </div>
  );
}

export default function HireForm() {
  const [jobType, setJobType] = useState<JobType>("website");
  const [description, setDescription] = useState("");
  const [account, setAccount] = useState<Address | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HireResult | null>(null);

  // Service cards and the hero menu on the home page pick the job type
  // here, so "Order" lands on the hire form with the right job selected.
  useEffect(() => {
    const onSelect = (e: Event) => {
      const t = (e as CustomEvent<JobType>).detail;
      if (JOB_TYPES.includes(t)) setJobType(t);
    };
    window.addEventListener("ikenga:select-job", onSelect);
    return () => window.removeEventListener("ikenga:select-job", onSelect);
  }, []);

  async function connect() {
    setConnectError(null);
    try {
      setAccount(await connectInjected());
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "Your wallet did not connect.");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!account) {
      setError("Connect your Celo wallet first — the job is paid from that wallet.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobType, description, customerWallet: account }),
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
        You pay $1 into escrow and only pay if you accept the work. If you
        turn it down, you get your $1 back.
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
            placeholder={DESCRIPTION_PLACEHOLDERS[jobType]}
            style={{ marginTop: 10 }}
          />
        </div>

        <div>
          <label className="field">
            Your Celo wallet
            <span className="hint">Connect the wallet you will pay from. Only that wallet can accept or turn down the work.</span>
          </label>
          {!account ? (
            <button onClick={connect} className="btn leaf lg block" style={{ marginTop: 10 }} type="button">
              Connect your Celo wallet
            </button>
          ) : (
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="text"
                value={account}
                readOnly
                aria-label="Your connected wallet address"
                style={{ flex: 1, minWidth: 200 }}
              />
              <button onClick={connect} className="btn" type="button">
                Change wallet
              </button>
            </div>
          )}
          {connectError && <p className="error" style={{ marginTop: 10 }}>{connectError}</p>}
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy || !account} className="btn leaf lg block">
          {busy ? "Checking with the CFO…" : "Hire Ikenga — $1"}
        </button>
        <p className="note" style={{ textAlign: "center" }}>
          First you connect your wallet, then you pay $1 into escrow. The
          work only starts once your $1 is in.
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
            {JOB_LABELS[result.jobType]} · ${result.priceUsdc}
          </p>
          <p style={{ marginTop: 6, color: "var(--ink-2)" }}>{result.cfoReason}</p>
          <p className="mono" style={{ marginTop: 10, fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
            The CFO&apos;s decision, written down: {result.decisionHash}
          </p>
          <PayPanel
            jobId={result.id}
            description={result.description}
            customerWallet={account ?? ""}
            account={account}
          />
        </div>
      )}
    </div>
  );
}
