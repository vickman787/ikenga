/** Explicit allowlist: public activity must never serialize customer records. */
export function publicActivity(data: Record<string, unknown>) {
  const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const summary = record(data.summary);
  const verify = record(data.verify);
  return {
    mode: typeof data.mode === "string" ? data.mode : undefined,
    backend: typeof data.backend === "string" ? data.backend : undefined,
    verify: { ok: verify.ok === true, entries: number(verify.entries), ordersChecked: number(verify.ordersChecked) },
    jobs: number(summary.jobs ?? data.jobs),
    summary: { jobs: number(summary.jobs ?? data.jobs), done: number(summary.done), settled: number(summary.settled), customers: number(summary.customers), excludedTestJobs: number(summary.excludedTestJobs) },
    onchainDecisions: typeof data.onchainDecisions === "number" ? number(data.onchainDecisions) : (Array.isArray(data.decisions) ? data.decisions.filter(d => typeof record(d).txHash === "string" && record(d).txHash).length : 0),
    note: "Aggregate activity only. Customer job details and decision text require verified access.",
  };
}
