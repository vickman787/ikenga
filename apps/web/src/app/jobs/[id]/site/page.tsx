"use client";

import WalletGate from "@/components/WalletGate";
import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { JOB_LABELS, type JobType } from "@ikenga/shared";

/**
 * The full page for a delivered website or flyer — /jobs/[id]/site.
 * The page itself is shown in a locked-down frame (scripts switched
 * off), with a plain bar on top saying what it is and who made it.
 * Other job types have nothing to show here.
 */
function JobSiteWorkspace() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [jobType, setJobType] = useState<JobType | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetch(`/api/jobs/${id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Job not found");
        setJobType(d.job.jobType as JobType);
        setHtml(typeof d.report?.html === "string" && d.report.html.length > 0 ? d.report.html : null);
        setLoaded(true);
      })
      .catch((e: Error) => { setError(e.message); setLoaded(true); });
  }, [id]);

  function downloadPage() {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = jobType === "flyers" ? "flyer.html" : "website.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
          padding: "12px 20px",
          background: "#13271C",
          color: "#FBF9F4",
          fontSize: 14,
        }}
      >
        <a href={`/jobs/${id}`} style={{ color: "#A3E36A", textDecoration: "none" }}>← Back to the job</a>
        <span style={{ opacity: 0.85 }}>
          {jobType ? `${JOB_LABELS[jobType]} — built by Ikenga from the customer's brief` : "Loading…"}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
          {jobType === "flyers" && (
            <button
              onClick={() => frameRef.current?.contentWindow?.print()}
              type="button"
              style={{ background: "#A3E36A", color: "#13271C", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontWeight: 700 }}
            >
              Print / save as PDF
            </button>
          )}
          {html && (
            <button
              onClick={downloadPage}
              type="button"
              style={{ background: "transparent", color: "#FBF9F4", border: "1px solid #FBF9F4", borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}
            >
              Download the page
            </button>
          )}
        </span>
      </div>
      {error && <p style={{ padding: 24, color: "var(--ink-2)" }}>{error}</p>}
      {!error && !loaded && <p style={{ padding: 24, color: "var(--muted)" }}>Loading…</p>}
      {!error && loaded && html !== null && jobType !== null && (jobType === "website" || jobType === "flyers") && (
        <iframe
          ref={frameRef}
          title={JOB_LABELS[jobType]}
          srcDoc={html}
          // Locked down: scripts are switched off, so nothing on the page
          // can run code. Same-origin is kept so the print button works.
          sandbox="allow-same-origin"
          style={{ flex: 1, width: "100%", border: "none", background: "#fff", minHeight: "calc(100vh - 57px)" }}
        />
      )}
      {!error && loaded && html !== null && jobType !== null && jobType !== "website" && jobType !== "flyers" && (
        <p style={{ padding: 24, color: "var(--ink-2)" }}>
          This job has no page to show here — the full page is only for
          websites and flyers. <a href={`/jobs/${id}`}>Back to the job →</a>
        </p>
      )}
      {!error && loaded && html === null && jobType !== null && (jobType === "website" || jobType === "flyers") && (
        <p style={{ padding: 24, color: "var(--ink-2)" }}>
          No page has been delivered for this job yet. <a href={`/jobs/${id}`}>Back to the job →</a>
        </p>
      )}
    </main>
  );
}

export default function JobSitePage() { return <WalletGate><JobSiteWorkspace /></WalletGate>; }
