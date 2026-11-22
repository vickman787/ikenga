"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { JOB_LABELS, type JobType } from "@ikenga/shared";
import Slideshow from "@/components/Slideshow";

/**
 * Job page — a hired job gets its own page, where you can watch the team
 * work, step by step. It reads the real /api/jobs/[id] record: the $1
 * quote, the bond the CFO puts up, and the decisions the CFO made. No
 * money moves here yet — escrow is not switched on, and the page says so
 * in plain words.
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
    slides?: { title: string; text: string }[];
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

/** Tiny markdown renderer for the report: headings, bold, lists, links, paragraphs. Escapes HTML first. */
function renderReport(md: string): { __html: string } {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = md.split("\n");
  let html = "";
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("### ")) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h3 style="font-size:17px;margin:18px 0 6px">${inline(line.slice(4))}</h3>`;
    } else if (line.startsWith("## ")) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h2 style="font-size:20px;margin:22px 0 8px">${inline(line.slice(3))}</h2>`;
    } else if (line.startsWith("# ")) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h2 style="font-size:22px;margin:22px 0 8px">${inline(line.slice(2))}</h2>`;
    } else if (line.startsWith("- ")) {
      if (!inList) { html += "<ul style=\"margin:6px 0 6px 18px;line-height:1.6\">"; inList = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
    } else if (line === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p style="margin:8px 0;line-height:1.65">${inline(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return { __html: html };
}

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

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [data, setData] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [revisionNote, setRevisionNote] = useState("");
  const [showRevise, setShowRevise] = useState(false);
  const [decisionMsg, setDecisionMsg] = useState<string | null>(null);
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
        const d = await res.json();
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
      const d = await res.json();
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

  async function decide(action: "accept" | "reject") {
    setDecisionMsg(null);
    const res = await fetch(`/api/jobs/${id}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const d = await res.json();
    if (!res.ok) {
      setDecisionMsg(d.error ?? "Could not record that");
      return;
    }
    setDecisionMsg(
      action === "accept"
        ? "Accepted — thank you. The team is paid from escrow once money moves."
        : "Turned down — you get your $1 back, plus the bond the CFO put up.",
    );
    await reload();
  }

  return (
    <main className="wrap" style={{ paddingTop: 48, paddingBottom: 96, maxWidth: 820 }}>
      <a href="/#hire" style={{ fontSize: 14, color: "var(--muted)" }}>← Back to Ikenga</a>
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
            <h2 style={{ fontSize: 20 }}>Who did what</h2>
            {!data.report && (
              <div className="card pad" style={{ marginTop: 12 }}>
                <p style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
                  {NOT_STARTED_BLURB[data.job.jobType]}
                </p>
                <button onClick={() => startWork()} disabled={running} className="btn leaf lg" style={{ marginTop: 16 }}>
                  {running ? "The team is working…" : "Start the work →"}
                </button>
                {runError && <p className="error" style={{ marginTop: 12 }}>{runError}</p>}
                <p style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
                  {COST_BLURB[data.job.jobType]} No money moves
                  on this job yet — the escrow is not switched on.
                </p>
              </div>
            )}
            {data.report && data.report.status === "refused" && (
              <div className="card pad" style={{ marginTop: 12 }}>
                <p style={{ color: "var(--ink-2)", lineHeight: 1.6 }}>
                  The team could not finish this job: {data.report.reason}
                </p>
                <button onClick={() => startWork()} disabled={running} className="btn leaf lg" style={{ marginTop: 16 }}>
                  {running ? "The team is working…" : "Try again →"}
                </button>
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
              <div key={`${s.agent}-${i}`} className="card pad" style={{ marginTop: 12 }}>
                <p><b>{s.agent}</b> — {s.what}</p>
                {s.detail && <p style={{ marginTop: 4, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.6 }}>{s.detail}</p>}
                {s.model && (
                  <p className="mono" style={{ marginTop: 6, fontSize: 12, color: "var(--muted)" }}>
                    {s.model}{s.tokens ? ` · ${s.tokens.toLocaleString()} tokens` : ""}{s.costUsd !== undefined ? ` · about $${s.costUsd.toFixed(4)}` : ""}
                  </p>
                )}
              </div>
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
                      </div>
                    </>
                  )}
                  {data.job.jobType === "promo-video" && data.report.slides && data.report.slides.length > 0 && (
                    <>
                      <h2 style={{ fontSize: 20 }}>Your promo slideshow</h2>
                      <p style={{ marginTop: 8, color: "var(--ink-2)", lineHeight: 1.6 }}>
                        Producer put this together from your brief. It is a
                        motion slideshow — moving slides with your
                        business&rsquo;s words — not a video file.
                      </p>
                      <div style={{ marginTop: 14 }}>
                        <Slideshow slides={data.report.slides} />
                      </div>
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
                    <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                      <button onClick={() => decide("accept")} className="btn leaf">Accept the work ✓</button>
                      <button onClick={() => setShowRevise((v) => !v)} className="btn">Ask for one free revision</button>
                      <button onClick={() => decide("reject")} className="btn">Turn it down — refund + bond</button>
                    </div>
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
                  </div>
                )}
                {data.job.status !== "delivered" && decisionMsg && (
                  <p style={{ marginTop: 16, color: "var(--ink-2)" }}>{decisionMsg}</p>
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
            No money has moved on this job yet. The escrow and vault are
            built but not switched on, so this is a price and a written
            record — not money in escrow.
          </p>
        </>
      )}
    </main>
  );
}
