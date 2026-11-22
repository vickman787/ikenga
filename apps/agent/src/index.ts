/** @ikenga/agent — the Ikenga team: the CFO loop, the market-report delivery, and the tool registry. */
export { AgentRunner, decide, type AgentDecision, type RunJobDeps, type RunJobResult, type ToolCall, type FxObligation } from "./agent.js";
export { runMarketReport, REPORT_MODEL_BUDGET_USD, REPORT_MAX_REVISIONS, type MarketReportResult, type ReportStep, type ReportSource, type RunReportInput, type RunReportDeps } from "./report.js";
export {
  chatFortyTwo,
  resolveFortyTwoKey,
  estimateCostUsd,
  worstCaseCostUsd,
  FORTYTWO_BASE_URL,
  FORTYTWO_MODEL_WORK,
  FORTYTWO_MODEL_AUDIT,
  type FortyTwoReply,
  type FortyTwoUsage,
} from "./fortytwo.js";
export { searchBing, searchWeb, searchWikipedia, fetchPageText, parseBingHtml, parseDuckDuckGoLite, type SearchResult, type SourcePage } from "./search.js";
export { ToolRegistry, type ToolSeller } from "./tools.js";
export { decideFx, bpsGap, type FxDecision } from "./fx.js";
