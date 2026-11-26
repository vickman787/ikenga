"use client";
import { renderReport } from "@/lib/reportPresentation";
import MediaExports from "@/components/MediaExports";

import WalletGate from "@/components/WalletGate";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { JOB_LABELS, buildStandaloneSlideshowHtml, type JobType } from "@ikenga/shared";
import Slideshow from "@/components/Slideshow";
import { PayPanel } from "@/components/HireForm";
import StepCard from "./StepCard";
import {
  acceptJob,
  connectInjected,
  ensureChain,
  explorerAddressUrl,
  explorerTxUrl,
  fetchChainConfig,
  rejectJob,
  shortAddress,
  type Address,
  type ChainConfig,
} from "@/lib/contracts";

/**
 * Job page — a hired job gets its own page, where you can watch the team
 * work, step by step. It reads the real /api/jobs/[id] record: the $1
 * quote, the escrow, and the decisions the CFO made.
 *
 * Money moves here, from the customer's own wallet: a job in "draft" shows
 * the pay panel (connect wallet, set up the job's escrow, pay $1 in) and
 * the work only starts once the job is "escrowed". A delivered job is
 * accepted or turned down on the chain first — the $1 goes to Ikenga, or
 * back to the wallet that paid — and only then is the decision saved.
 *
 * All four jobs are delivered here: the market report (words + sources),
 * the website and the flyers (a real page built from the brief, shown
 * in a locked-down frame that cannot run code), and the promo video
 * (a motion slideshow — moving slides, not a video file — and the page
 * says so plainly).
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
    // Added by the escrow work: null until the customer pays. The server
    // may not send these yet — every use below treats them as optional.
    escrowAddress?: string | null;
    fundTxHash?: string | null;
    deliverableTxHash?: string | null;
    settleTxHash?: string | null;
    escrowState?: "unfunded" | "funded" | "accepted" | "rejected" | "released" | null;
    // Added by the cNGN work: which currency the job is paid in, and the
    // exact price fixed at hire time. Old jobs have none of these — they
    // default to $1 USDT on the panel.
    payCurrency?: "USDT" | "USDC" | "cNGN";
    priceAtomic?: string;
    priceRate?: string | null;
    tokenAddress?: string;
    vaultAddress?: string;
  };
  report: {
    report: string;
    sources: { title: string; url: string }[];
    steps: { agent: string; what: string; detail: string; model?: string; tokens?: number; costUsd?: number }[];
    totalTokens: number;
    totalCostUsd: number;
    status: "delivered" | "refused" | "in-progress";
    reason?: string;
    revisions: number;
    deliveredAt: string;
    stage: number;
    deliverableKind?: "report" | "website" | "flyer" | "slideshow";
    html?: string;
    designSvg?: string;
    slides?: { title: string; text: string; image?: string }[];
  } | null;
  nextStep: string | null;
  backend: string;
  decisions: { id: string; kind: string; reason: string; hash: string; createdAt: string }[];
  verify: { ok: boolean };
  fxSwaps: unknown[];
  reconciliation: { settled: number; unresolved: number; failed: number };
}

/** What the team will do, before it has started — one line per job type. */
const NOT_STARTED_BLURB: Record<JobType, string> = {
  "market-report":
    "The team has not started this report yet. Scout will look the market up, Researcher will plan it, Writer will write it, Analyst will check the numbers, and a different model will read it before it reaches you.",
  website:
    "The team has not started this website yet. Designer will read your brief and build your one-page website, Analyst will check every word against your brief, and a different model will read it before it reaches you.",
  flyers:
    "The team has not started this flyer yet. Designer will read your brief and make your flyer and price list, Analyst will check every price against your brief, and a different model will read it before it reaches you.",
  "promo-video":
    "The team has not started this promo yet. Producer will read your brief and put your slideshow together, Analyst will check every word against your brief, and a different model will read it before it reaches you.",
};

/** What one finished job costs the team in AI time, in plain words. */
const COST_BLURB: Record<JobType, string> = {
  "market-report": "The report costs about a cent of AI time.",
  website: "The website costs about a cent of AI time.",
  flyers: "The flyer costs about a cent of AI time.",
  "promo-video": "The slideshow costs about a cent of AI time.",
};


/**
 * A delivered website or flyer, shown in a locked-down frame: the page
 * cannot run code (no scripts are allowed) and cannot reach out. The
 * flyer gets print and download buttons; the website gets a link to
 * its own full page.
 */
function PagePreview({ jobId, jobType, html }: { jobId: string; jobType: JobType; html: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const isFlyer = jobType === "flyers";

  function printFlyer() {
    frameRef.current?.contentWindow?.print();
  }

  function downloadPage() {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = isFlyer ? "flyer.html" : "website.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <iframe
        ref={frameRef}
        title={isFlyer ? "Your flyer" : "Your website"}
        srcDoc={html}
        // Locked down: scripts are switched off, so nothing on the page
        // can run code. Same-origin is kept so the print button works.
        sandbox="allow-same-origin"
        style={{ width: "100%", height: isFlyer ? 560 : 600, border: "1px solid var(--hatch-widget-border, #ddd6c4)", borderRadius: 12, background: "#fff" }}
      />
      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {isFlyer && (
          <button onClick={printFlyer} className="btn leaf" type="button">
            Print / save as PDF
          </button>
        )}
        <button onClick={downloadPage} className="btn" type="button">
          Download the page
        </button>
        <a href={`/jobs/${jobId}/site`} className="btn" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
          Open the full {isFlyer ? "flyer" : "website"} →
        </a>
      </div>
      <p style={{ marginTop: 12, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
        Built from your brief — every word comes from what you told us.
        The page is shown in a locked-down frame, so nothing on it can
        run code or send anything anywhere.
      </p>
    </div>
  );
}

function JobWorkspace() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [showRevise, setShowRevise] = useState(false);
  const [decisionMsg, setDecisionMsg] = useState<string | null>(null);
  const [decisionTxHash, setDecisionTxHash] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [account, setAccount] = useState<Address | null>(null);
  const [chain, setChain] = useState<ChainConfig | null>(null);
  // The latest job data, for the stage driver (refs do not go stale).
  const dataRef = useRef<JobDetail | null>(null);
  // True while this page is driving the stages — the poller must not
  // start a second driver.
  const drivingRef = useRef(false);

  const reload = async () => {
    const r = await fetch(`/api/jobs/${id}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? "Job not found");
    dataRef.current = d;
    setData(d);
  };

  useEffect(() => {
    reload().catch((e: Error) => setError(e.message));
    // The payment details (chain, vault, token, explorer) come from the
    // server. If that route is not there yet, the page still works — the
    // explorer links just stay hidden until it is.
    fetchChainConfig().then(setChain).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // While the team is working, check in every few seconds. If this page
  // is not already driving the stages, pick the next stage up — so a
  // refresh mid-run, or a stage that finished on another request, still
  // moves the job forward.
  useEffect(() => {
    if (!data || data.job.status !== "in-progress") return;
    const t = setInterval(() => {
      if (drivingRef.current) return;
      reload()
        .then(() => driveStages())
        .catch(() => {});
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.job.status]);

  /** Run the stages one by one until the work is delivered or refused. */
  async function driveStages() {
    if (drivingRef.current) return;
    drivingRef.current = true;
    setRunning(true);
    setRunError(null);
    try {
      for (;;) {
        const cur = dataRef.current;
        if (!cur?.report || cur.report.status !== "in-progress" || cur.report.stage === 0) break;
        const res = await fetch(`/api/jobs/${id}/run/step`, { method: "POST" });
        // A failed step must say so in plain words — never surface a
        // JSON parse error when the server answers with an empty body.
        const d = await res.json().catch(() => ({} as { error?: string }));
        if(res.status===202){await new Promise(resolve=>setTimeout(resolve,2000));continue;}
        if (!res.ok) throw new Error(d.error ?? "The team could not finish this step");
        await reload();
        if (d.done) break;
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "The team could not finish the work");
    } finally {
      drivingRef.current = false;
      setRunning(false);
    }
  }

  async function startWork(note?: string) {
    setRunning(true);
    setRunError(null);
    try {
      const res = await fetch(`/api/jobs/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(note ? { revisionNote: note } : {}),
      });
      // Same guard as driveStages: an empty answer must become a
      // plain-words error, never a JSON parse failure.
      const d = await res.json().catch(() => ({} as { error?: string }));
      if (!res.ok) throw new Error(d.error ?? "The team could not start the work");
      setShowRevise(false);
      setRevisionNote("");
      await reload();
      await driveStages();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "The team could not finish the work");
      setRunning(false);
    }
  }

  /**
   * Accept or turn down the delivered work. The money moves on the chain
   * FIRST, from the wallet that paid — only that wallet can accept or turn
   * a job down — and only then is the decision saved with the transaction
   * hash. A different wallet is refused in plain words, and nothing is
   * saved without a transaction hash.
   */
  async function decide(action: "accept" | "reject") {
    setDecisionMsg(null);
    setDecisionTxHash(null);
    setDeciding(true);
    try {
      // Always ask the wallet which account is selected right now — the
      // customer may have switched accounts since connecting.
      const acct = await connectInjected();
      setAccount(acct);
      if (acct.toLowerCase() !== dataRef.current?.job.customerWallet.toLowerCase()) {
        throw new Error(
          `That wallet (${shortAddress(acct)}) did not pay for this job. Only the wallet that paid (${shortAddress(dataRef.current?.job.customerWallet ?? "")}) can accept or turn it down.`,
        );
      }
      const cfg = chain ?? (await fetchChainConfig());
      setChain(cfg);
      await ensureChain(cfg.chainId);
      const escrowAddress = dataRef.current?.job.escrowAddress;
      if (!escrowAddress) {
        throw new Error(
          "This job has no escrow saved yet. Pay the $1 into escrow first, then decide.",
        );
      }
      setDecisionMsg(
        action === "accept"
          ? "Sending your acceptance to the chain…"
          : "Sending your refund to the chain…",
      );
      const { txHash } =
        action === "accept"
          ? await acceptJob({ account: acct, chain: cfg, escrowAddress: escrowAddress as Address })
          : await rejectJob({ account: acct, chain: cfg, escrowAddress: escrowAddress as Address });
      setDecisionTxHash(txHash);
      const res = await fetch(`/api/jobs/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, txHash }),
      });
      const d = await res.json();
      if (!res.ok) {
        throw new Error(
          d.error ??
            "The money moved on the chain, but we could not save the decision. Tell us and we will sort it out.",
        );
      }
      setDecisionMsg(
        action === "accept"
          ? "Accepted — thank you. The $1 in escrow goes to Ikenga."
          : "Turned down — your $1 is on its way back to your wallet.",
      );
      await reload();
    } catch (e) {
      setDecisionMsg(
        e instanceof Error ? e.message : "Could not record that",
      );
    } finally {
      setDeciding(false);
    }
  }

  // What the customer paid, in plain words — "$1", or the fixed cNGN
  // amount for a cNGN job. Old jobs have no payment fields: $1 USDT.
  const amountLabel =
    data?.job.payCurrency === "cNGN" && data.job.priceAtomic
      ? `${(BigInt(data.job.priceAtomic) / 1_000_000n).toLocaleString("en-NG")} cNGN`
      : "$1";

  return (
    <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96, maxWidth: 820 }}>
      <a href="/jobs" style={{ fontSize: 14, color: "var(--muted)" }}>← My jobs</a>
      {error && (
        <div className="card pad" style={{ marginTop: 24 }}>
          <h1 style={{ fontSize: 28 }}>Job not found</h1>
          <p style={{ marginTop: 8, color: "var(--ink-2)" }}>{error}</p>
          <p style={{ marginTop: 8, color: "var(--ink-2)" }}>
            Jobs are saved in the site&apos;s database once it is connected.
            A job made before that was connected may be gone.
          </p>
        </div>
      )}
      {!error && !data && <p style={{ marginTop: 24, color: "var(--muted)" }}>Loading your job…</p>}
      {data && (
        <>
          <div style={{ marginTop: 24 }}>
            <span className="chip live">
              <span className="dot" /> {data.job.status}
            </span>
          </div>
          <h1 style={{ fontSize: 36, marginTop: 14 }}>{JOB_LABELS[data.job.jobType]}</h1>
          <p style={{ marginTop: 10, fontSize: "var(--lede)", color: "var(--ink-2)", lineHeight: 1.6 }}>
            {data.job.description}
          </p>
          <div className="card pad" style={{ marginTop: 24, display: "grid", gap: 12 }}>
            <p>
              <b>Price:</b>{" "}
              {data.job.payCurrency === "cNGN" && data.job.priceAtomic
                ? `${(BigInt(data.job.priceAtomic) / 1_000_000n).toLocaleString("en-NG")} cNGN`
                : `$${data.job.priceUsdc}`}
              {data.job.payCurrency === "cNGN" && data.job.priceRate
                ? ` (fixed at ${data.job.priceRate} cNGN per $1)`
                : ""}
            </p>
            <p><b>Paying wallet:</b> <span className="mono" style={{ fontSize: 13, wordBreak: "break-all" }}>{data.job.customerWallet}</span></p>
            {data.job.escrowAddress ? (
              <p>
                <b>Your {amountLabel}:</b> {data.job.escrowState === "accepted"
                  ? "paid to Ikenga — you accepted the work"
                  : data.job.escrowState === "rejected"
                    ? "refunded — you turned the work down"
                    : data.job.escrowState === "funded"
                      ? "in escrow"
                      : "escrow set up, waiting for your payment"}{" "}
                {chain && (
                  <a
                    href={explorerAddressUrl(chain, data.job.escrowAddress)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono"
                    style={{ fontSize: 12, wordBreak: "break-all" }}
                  >
                    See the escrow on the chain →
                  </a>
                )}
              </p>
            ) : (
              <p><b>Your {amountLabel}:</b> not paid yet — pay below and the team can start.</p>
            )}
            {data.job.fundTxHash && chain && (
              <p>
                <b>{amountLabel} payment:</b>{" "}
                <a
                  href={explorerTxUrl(chain, data.job.fundTxHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ fontSize: 12, wordBreak: "break-all" }}
                >
                  See it on the chain →
                </a>
              </p>
            )}
            {(data.job.settleTxHash ?? decisionTxHash) && chain && (
              <p>
                <b>Settled:</b>{" "}
                <a
                  href={explorerTxUrl(chain, (data.job.settleTxHash ?? decisionTxHash) as string)}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ fontSize: 12, wordBreak: "break-all" }}
                >
                  See it on the chain →
                </a>
              </p>
            )}
            <p><b>The CFO says:</b> {data.job.cfoReason}</p>
            <p className="mono" style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all" }}>
              The CFO&apos;s decision, written down: {data.job.decisionHash}
            </p>
            <p><b>The money log:</b> {data.verify.ok ? "✓ checks out" : "✕ doesn&apos;t check out"}</p>
            <p><b>Tool payments:</b> {data.reconciliation.settled} settled · {data.reconciliation.unresolved} waiting · {data.reconciliation.failed} failed</p>
            <p><b>Money changed to naira:</b> {data.fxSwaps.length} {data.fxSwaps.length === 1 ? "swap" : "swaps"} so far</p>
          </div>
          <div style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 20 }}>Who did what</h2>
            {!data.report && (
              <div className="card pad" style={{ marginTop: 12 }}>
                <p style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
                  {NOT_STARTED_BLURB[data.job.jobType]}
                </p>
                {data.job.status === "draft" ? (
                  <PayPanel
                    jobId={data.job.id}
                    description={data.job.description}
                    customerWallet={data.job.customerWallet}
                    payCurrency={data.job.payCurrency}
                    priceAtomic={data.job.priceAtomic}
                    priceRate={data.job.priceRate}
                    tokenAddress={data.job.tokenAddress}
                    vaultAddress={data.job.vaultAddress}
                    account={account}
                    onPaid={() => reload().catch(() => {})}
                  />
                ) : (
                  <>
                    <button onClick={() => startWork()} disabled={running} className="btn leaf lg" style={{ marginTop: 16 }}>
                      {running ? "The team is working…" : "Start the work →"}
                    </button>
                    {runError && <p className="error" style={{ marginTop: 12 }}>{runError}</p>}
                  </>
                )}
                <p style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
                  {COST_BLURB[data.job.jobType]} Your {amountLabel} is held in escrow
                  until you accept the work — turn it down and it comes
                  back to your wallet.
                </p>
              </div>
            )}
            {data.report && data.report.status === "refused" && (
              <div className="card pad" style={{ marginTop: 12 }}>
                <p style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
                  The team could not finish this job: {data.report.reason}
                </p>
                {data.job.escrowState === "funded" && <><p style={{marginTop:12}}>Your payment is still in escrow. You can retry within this job’s remaining budget or request your refund.</p><div style={{display:"flex",gap:12,flexWrap:"wrap",marginTop:16}}><button onClick={() => startWork()} disabled={running || deciding} className="btn leaf" type="button">{running ? "The team is working…" : "Try again"}</button><button onClick={()=>decide("reject")} disabled={deciding || running} className="btn" type="button">Request refund</button></div></>}
                {decisionMsg && <p role="status" style={{marginTop:12}}>{decisionMsg}</p>}
                {runError && <p className="error" style={{ marginTop: 12 }}>{runError}</p>}
              </div>
            )}
            {data.report && data.report.status === "in-progress" && (
              <div className="card pad" style={{ marginTop: 12 }}>
                <p style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
                  {running ? (data.nextStep ? `${data.nextStep}…` : "The team is working…") : "The team is working — the page will pick the next step up on its own."}
                </p>
                <p style={{ marginTop: 8, fontSize: 13, color: "var(--muted)" }}>
                  This takes a few minutes. Each finished step shows below as it lands — you can wait here.
                </p>
                {runError && <p className="error" style={{ marginTop: 12 }}>{runError}</p>}
              </div>
            )}
            {data.report && data.report.steps.map((s, i) => (
              <StepCard key={`${s.agent}-${i}`} step={s} />
            ))}
            {data.report && data.report.status === "delivered" && (
              <>
                <div className="card pad" style={{ marginTop: 24 }}>
                  {data.job.jobType === "market-report" && (
                    <>
                      <h2 style={{ fontSize: 20 }}>Your report</h2>
                      <div dangerouslySetInnerHTML={renderReport(data.report.report)} />
                      {data.report.sources.length > 0 && (
                        <>
                          <h3 style={{ fontSize: 16, marginTop: 20 }}>Sources</h3>
                          <ul style={{ margin: "6px 0 0 18px", lineHeight: 1.7 }}>
                            {data.report.sources.map((s) => (
                              <li key={s.url}>
                                <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </>
                  )}
                  {data.job.jobType === "website" && data.report.html && (
                    <>
                      <h2 style={{ fontSize: 20 }}>Your website</h2>
                      <p style={{ marginTop: 8, color: "var(--ink-2)", lineHeight: 1.6 }}>
                        Designer built this one-page website from your brief.
                      </p>
                      <div style={{ marginTop: 14 }}>
                        <PagePreview jobId={data.job.id} jobType={data.job.jobType} html={data.report.html} />
                      </div>
                    </>
                  )}
                  {data.job.jobType === "flyers" && data.report.html && (
                    <>
                      <h2 style={{ fontSize: 20 }}>Your flyer</h2>
                      <p style={{ marginTop: 8, color: "var(--ink-2)", lineHeight: 1.6 }}>
                        Designer made this flyer and price list from your
                        brief. Prices come from your brief — where you gave
                        no price, it says &ldquo;price not listed&rdquo;.
                      </p>
                      <div style={{ marginTop: 14 }}>
                        <PagePreview jobId={data.job.id} jobType={data.job.jobType} html={data.report.html} />
                        {data.report.designSvg && <MediaExports svg={data.report.designSvg} />}
                      </div>
                    </>
                  )}
                  {data.job.jobType === "promo-video" && data.report.slides && data.report.slides.length > 0 && (
                    <>
                      <h2 style={{ fontSize: 20 }}>Your promo slideshow</h2>
                      <p style={{ marginTop: 8, color: "var(--ink-2)", lineHeight: 1.6 }}>
                        Producer put this together from your brief. It is a
                        motion slideshow — moving slides with your
                        business&rsquo;s words. Use the video download below to export a silent video file.
                      </p>
                      <div style={{ marginTop: 14 }}>
                        <Slideshow slides={data.report.slides} />
                        <MediaExports slides={data.report.slides} />
                      </div>
                      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
                        <button
                          onClick={() => {
                            const html = buildStandaloneSlideshowHtml(data.report?.slides ?? []);
                            const blob = new Blob([html], { type: "text/html" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = "slideshow.html";
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          className="btn"
                          type="button"
                        >
                          Download the slideshow
                        </button>
                      </div>
                      <p style={{ marginTop: 12, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
                        A standalone file — it plays the same slides with the
                        picture, and needs nothing else to open.
                      </p>
                    </>
                  )}
                  <p style={{ marginTop: 16, fontSize: 13, color: "var(--muted)" }}>
                    The whole job cost about ${data.report.totalCostUsd.toFixed(4)} of AI time
                    ({data.report.totalTokens.toLocaleString()} tokens)
                    {data.report.revisions > 0 ? `, including ${data.report.revisions} free revision` : ""}.
                  </p>
                </div>
                {data.job.status === "delivered" && (
                  <div className="card pad" style={{ marginTop: 16 }}>
                    <h3 style={{ fontSize: 18 }}>What do you think?</h3>
                    <p style={{ marginTop: 6, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.6 }}>
                      Accepting sends the $1 in escrow to Ikenga. Turning it
                      down sends the $1 back to the wallet that paid. Either
                      way, your wallet will ask you to confirm — only the
                      wallet that paid can decide.
                    </p>
                    <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                      <button onClick={() => decide("accept")} disabled={deciding} className="btn leaf">Accept the work ✓</button>
                      {(data.report.revisions ?? 0) < 1 ? (
                        <button onClick={() => setShowRevise((v) => !v)} disabled={deciding} className="btn">Ask for one free revision</button>
                      ) : (
                        <span style={{ fontSize: 13, color: "var(--muted)", alignSelf: "center" }}>
                          You used your one free revision.
                        </span>
                      )}
                      <button onClick={() => decide("reject")} disabled={deciding} className="btn">Turn it down — get your $1 back</button>
                    </div>
                    {deciding && <p style={{ marginTop: 12, color: "var(--ink-2)" }}>Waiting for your wallet…</p>}
                    {showRevise && (
                      <div style={{ marginTop: 14 }}>
                        <label className="field" htmlFor="revision-note">What should change?</label>
                        <input
                          id="revision-note"
                          type="text"
                          value={revisionNote}
                          onChange={(e) => setRevisionNote(e.target.value)}
                          placeholder="e.g. Add the prices for each option"
                          style={{ marginTop: 8 }}
                        />
                        <button onClick={() => startWork(revisionNote || "Make it clearer and shorter")} disabled={running} className="btn leaf" style={{ marginTop: 10 }}>
                          {running ? "Revising…" : "Send the revision →"}
                        </button>
                        {runError && <p className="error" style={{ marginTop: 12 }}>{runError}</p>}
                      </div>
                    )}
                    {decisionMsg && <p style={{ marginTop: 12, color: "var(--ink-2)" }}>{decisionMsg}</p>}
                    {decisionTxHash && chain && (
                      <p style={{ marginTop: 8 }}>
                        <a
                          href={explorerTxUrl(chain, decisionTxHash)}
                          target="_blank"
                          rel="noreferrer"
                          className="mono"
                          style={{ fontSize: 12, wordBreak: "break-all" }}
                        >
                          See it on the chain →
                        </a>
                      </p>
                    )}
                  </div>
                )}
                {data.job.status !== "delivered" && decisionMsg && (
                  <p style={{ marginTop: 16, color: "var(--ink-2)" }}>{decisionMsg}</p>
                )}
                {data.job.status !== "delivered" && decisionTxHash && chain && (
                  <p style={{ marginTop: 8 }}>
                    <a
                      href={explorerTxUrl(chain, decisionTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                      style={{ fontSize: 12, wordBreak: "break-all" }}
                    >
                      See it on the chain →
                    </a>
                  </p>
                )}
              </>
            )}
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
            {data.job.status === "draft"
              ? `Your ${amountLabel} is not paid yet. Pay it into escrow above and the team can start.`
              : data.job.escrowState === "accepted"
                ? `Settled: you accepted the work and the ${amountLabel} in escrow went to Ikenga.`
                : data.job.escrowState === "rejected"
                  ? `Settled: you turned the work down and the ${amountLabel} went back to your wallet.`
                  : `Your ${amountLabel} is held in escrow until you accept the work — turn it down and it comes back to your wallet.`}
          </p>
        </>
      )}
    </main>
  );
}

export default function JobPage() { return <WalletGate><JobWorkspace /></WalletGate>; }
