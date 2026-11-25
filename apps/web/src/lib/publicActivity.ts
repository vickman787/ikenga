/** Explicit allowlist: public activity must never serialize customer records. */
export function publicActivity(data: Record<string, unknown>) {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const summary = record(data.summary);
  const verify = record(data.verify);
  return {
    verify: { ok: verify.ok === true },
    summary: { jobs: number(summary.jobs ?? data.jobs), done: number(summary.done), settled: number(summary.settled), customers: number(summary.customers) },
    onchainDecisions: typeof data.onchainDecisions === "number" ? number(data.onchainDecisions) : (Array.isArray(data.decisions) ? data.decisions.filter(d => typeof record(d).txHash === "string" && record(d).txHash).length : 0),
    note: "Aggregate activity only. Customer job details and decision text require verified access.",
  };
}

/** Legacy traction reads expose customer totals only, including in review previews. */
export function publicTraction(data: Record<string, unknown>) {
  const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  return { jobsStarted: count(data.jobsStarted), customers: count(data.customers) };
}
