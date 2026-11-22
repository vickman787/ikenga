/**
 * Local end-to-end market-report run (manual, not a test — it spends real
 * FortyTwo credits, a few cents).
 *
 * Usage (key from env, never printed or logged):
 *   FORTYTWO_API_KEY=... pnpm --filter @ikenga/agent run:report "Compare payment options for my shop in Lagos"
 *
 * Prints the agent steps, the token/cost totals, and the report itself.
 * The key is read from the environment only; this script never prints it.
 */
import { writeFileSync } from "node:fs";
import { runMarketReport } from "./report.js";
import { resolveFortyTwoKey } from "./fortytwo.js";

const brief = process.argv.slice(2).join(" ").trim();
if (!brief) {
  console.error('Usage: run:report "Compare payment options for my shop in Lagos"');
  process.exit(2);
}
// Fail fast with a plain message when the AI is not connected.
resolveFortyTwoKey();

const result = await runMarketReport({ brief });
console.log(`Status: ${result.status}`);
if (result.reason) console.log(`Reason: ${result.reason}`);
console.log(`Steps: ${result.steps.length} · Tokens: ${result.totalTokens} · Cost: $${result.totalCostUsd.toFixed(4)} · Revisions: ${result.revisions}`);
for (const s of result.steps) {
  console.log(`- ${s.agent}: ${s.what}${s.model ? ` [${s.model}]` : ""}${s.costUsd !== undefined ? ` $${s.costUsd.toFixed(4)}` : ""}`);
  if (s.detail) console.log(`    ${s.detail.slice(0, 500).replace(/\n/g, " ")}`);
}
console.log(`Sources (${result.sources.length}):`);
for (const s of result.sources) console.log(`  - ${s.title} — ${s.url}`);
if (result.report) {
  writeFileSync("market-report-sample.md", result.report);
  console.log("\n--- REPORT ---\n");
  console.log(result.report);
}
