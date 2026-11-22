/**
 * The market report — the first job Ikenga can really deliver.
 *
 * Who does what (the same team as the landing page):
 *   Scout      — searches the web and reads the pages (DuckDuckGo Lite +
 *                Wikipedia, free, no key). Every fact comes from a page
 *                Scout actually read, with its link shown.
 *   Researcher — turns the brief + what Scout found into a short plan.
 *   Writer     — writes the report, in plain words, only from the sources.
 *   Analyst    — checks every number, price and date against the sources.
 *   Auditor    — reads it on a DIFFERENT model and says pass or fix. If it
 *                says fix, Writer revises once. One revision, then it ships.
 *
 * Money rules (the CFO's rules, not the models'):
 *   - A whole report may cost at most $0.50 of model time. A normal report
 *     is a few cents. If the next call would push past the cap, the job
 *     stops and says so instead of overspending.
 *   - The weekly tool budget is 30 USDT and one move may be at most 5 USDT
 *     (the vault rules) — a $0.50 cap sits far inside both.
 *   - No model ever touches money: models only write words. The price,
 *     the bond and the accept/reject decision stay with the CFO.
 *
 * The chat and search calls are injectable, so tests can run the whole
 * flow with fakes and never spend a cent or touch the network.
 */
import {
  FORTYTWO_MODEL_AUDIT,
  FORTYTWO_MODEL_WORK,
  approxTokens,
  chatFortyTwo,
  worstCaseCostUsd,
  type FortyTwoReply,
} from "./fortytwo.js";
import { fetchPageText, searchBing, searchWeb, searchWikipedia, type SearchResult, type SourcePage } from "./search.js";

export const REPORT_MODEL_BUDGET_USD = 0.5;
export const REPORT_MAX_REVISIONS = 1;

export interface ReportStep {
  agent: "Scout" | "Researcher" | "Writer" | "Analyst" | "Auditor";
  what: string;
  detail: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
}

export interface ReportSource {
  title: string;
  url: string;
}

export interface MarketReportResult {
  /** The report itself, in markdown. */
  report: string;
  sources: ReportSource[];
  steps: ReportStep[];
  totalTokens: number;
  totalCostUsd: number;
  /** "delivered" when the Auditor passed it (after at most one revision). */
  status: "delivered" | "refused";
  /** Plain-words reason when refused (e.g. budget, no sources, no AI key). */
  reason?: string;
  revisions: number;
}

export interface RunReportDeps {
  chat?: (input: { model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; maxTokens?: number; reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }) => Promise<FortyTwoReply>;
  search?: (query: string, limit?: number) => Promise<SearchResult[]>;
  /** Primary web search (Bing). Defaults to the real one. */
  searchBing?: (query: string, limit?: number) => Promise<SearchResult[]>;
  wiki?: (query: string, limit?: number) => Promise<SourcePage[]>;
  fetchPage?: (url: string) => Promise<SourcePage | null>;
  /** Extra instructions from the customer ("ask for one free revision"). */
  revisionNote?: string;
  /** Sources already gathered (a revision reuses them — no new search). */
  existingSources?: SourcePage[];
}

export interface RunReportInput {
  /** The customer's brief, as typed in the Hire form. */
  brief: string;
}

function sourcesText(pages: SourcePage[]): string {
  // Short extracts only — a long dump invites the Writer to paste the
  // sources into the report instead of writing its own words.
  return pages
    .map((p, i) => `[${i + 1}] ${p.title} — ${p.url}\n${p.text.slice(0, 1200)}`)
    .join("\n\n");
}

function stripCodeFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/gim, "").replace(/```$/gm, "").trim();
}

export async function runMarketReport(input: RunReportInput, deps: RunReportDeps = {}): Promise<MarketReportResult> {
  const brief = input.brief.trim();
  if (!brief) {
    return { report: "", sources: [], steps: [], totalTokens: 0, totalCostUsd: 0, status: "refused", reason: "There was no brief to work from.", revisions: 0 };
  }
  const rawChat = deps.chat ?? (async (c) => chatFortyTwo(c));
  /** One chat call; if the model answers with nothing (its thinking ate
   * the token budget), try once more with twice the budget. */
  const chat = async (c: Parameters<NonNullable<RunReportDeps["chat"]>>[0]): Promise<FortyTwoReply> => {
    const first = await rawChat(c);
    if (first.text.trim().length > 0) return first;
    return rawChat({ ...c, maxTokens: (c.maxTokens ?? 1024) * 2 });
  };
  const search = deps.search ?? searchWeb;
  const searchBingFn = deps.searchBing ?? searchBing;
  const wiki = deps.wiki ?? searchWikipedia;
  const fetchPage = deps.fetchPage ?? fetchPageText;

  const steps: ReportStep[] = [];
  let totalTokens = 0;
  let totalCostUsd = 0;

  const charge = (reply: FortyTwoReply, agent: ReportStep["agent"], what: string) => {
    totalTokens += reply.usage.totalTokens;
    totalCostUsd = Math.round((totalCostUsd + reply.costUsd) * 1_000_000) / 1_000_000;
    steps.push({ agent, what, detail: "", model: reply.model, tokens: reply.usage.totalTokens, costUsd: reply.costUsd });
  };

  /** Refuse instead of overspending: check the worst case before each call. */
  const withinBudget = (model: string, prompt: string, maxTokens: number): boolean =>
    totalCostUsd + worstCaseCostUsd(model, approxTokens(prompt), maxTokens) <= REPORT_MODEL_BUDGET_USD;

  /** Already spent too much (a call cost more than its worst case) — stop now. */
  const overBudget = (): boolean => totalCostUsd > REPORT_MODEL_BUDGET_USD;

  const refuse = (reason: string): MarketReportResult => ({
    report: "", sources: [], steps, totalTokens, totalCostUsd, status: "refused", reason, revisions: 0,
  });

  // --- Scout: search, then read the pages. ---
  // A long brief returns nothing from Wikipedia and little from the web,
  // so Scout also tries the names inside it: the part after a colon
  // ("Paystack, Flutterwave and Moniepoint") and the capitalised words.
  const afterColon = brief.includes(":") ? brief.split(":").slice(1).join(":").trim() : "";
  // Capitalised words after the first word of the brief (the first word is
  // capitalised just for starting the sentence — it is not a name).
  const named = [...new Set(brief.split(/\s+/).slice(1).filter((w) => /^[A-Z][a-zA-Z]{2,}$/.test(w.replace(/[^a-zA-Z]/g, ""))))].join(" ");
  const keywords = [afterColon, named].map((s) => s.replace(/[^a-zA-Z0-9 ,&]/g, "").trim()).filter(Boolean);
  const mainTopic = keywords[0] ?? brief;
  let pages: SourcePage[] = deps.existingSources ?? [];
  let webResults: SearchResult[] = [];
  if (pages.length === 0) {
    const queries = [...new Set([mainTopic, `${mainTopic} Nigeria`, `${mainTopic} fees`, `${mainTopic} vs`])];
    for (const q of queries) {
      // Bing first (reliable), DuckDuckGo as a backup.
      for (const fn of [searchBingFn, search]) {
        try {
          const found = await fn(q, 5);
          for (const r of found) if (!webResults.some((x) => x.url === r.url)) webResults.push(r);
          if (webResults.length >= 8) break;
        } catch {
          // One failed search never stops the report — Scout tries the next one.
        }
      }
      if (webResults.length >= 8) break;
    }
    // Wikipedia wants one name at a time — "Paystack, Flutterwave" finds
    // nothing, "Paystack" finds the page. Try the first three named terms.
    const wikiTerms = mainTopic.split(/[,，&]| and /).map((s) => s.replace(/[^a-zA-Z0-9 ]/g, "").trim()).filter((s) => s.length > 2).slice(0, 3);
    for (const term of wikiTerms.length > 0 ? wikiTerms : [brief]) {
      const found = await wiki(term, 1).catch(() => [] as SourcePage[]);
      for (const p of found) if (!pages.some((x) => x.url === p.url)) pages.push(p);
    }
    // Read the web results, but only keep pages that actually mention
    // what the customer asked about — a page that matches the word
    // "compare" and nothing else is not a source for this report.
    // Read the web results, but only keep pages that actually mention
    // what the customer asked about — a page that matches the word
    // "compare" and nothing else is not a source for this report. A page
    // passes if it mentions any named business or any content word.
    const mustMention = [
      ...wikiTerms,
      ...brief.split(/\s+/).filter((w) => w.length > 4).slice(0, 6),
    ].map((w) => w.replace(/[^a-zA-Z0-9 ]/g, "").trim()).filter((w) => w.length > 2);
    const mentionsTopic = (text: string) => {
      const lower = text.toLowerCase();
      return mustMention.some((t) => lower.includes(t.toLowerCase()));
    };
    for (const r of webResults) {
      if (pages.length >= 6) break;
      const page = await fetchPage(r.url);
      if (!page) continue;
      if (!mentionsTopic(page.text) && !mentionsTopic(r.title)) continue;
      if (pages.some((p) => p.url === page.url)) continue;
      pages.push({ title: r.title, url: page.url, text: page.text });
    }
  }
  const sources: ReportSource[] = pages.map((p) => ({ title: p.title, url: p.url }));
  steps.push({
    agent: "Scout",
    what: `Looked up "${brief}" and read ${pages.length} ${pages.length === 1 ? "page" : "pages"}.`,
    detail: pages.length > 0 ? `Sources: ${sources.map((s) => s.title).join("; ")}` : "Nothing readable came back — so there is no report to write from.",
  });
  if (pages.length === 0) {
    return refuse("Scout could not find anything readable about this — so there is no report to write from. Try a clearer brief, with the business or market named.");
  }
  const sourceText = sourcesText(pages);

  // --- Researcher: a short plan from the brief + sources. ---
  const planPrompt = `You are Researcher, planning a short market report for a small business owner in Nigeria.\n\nThe job: ${brief}\n\nWhat Scout found (only use facts from here):\n${sourceText}\n\nWrite a short plan: the businesses or options to compare, the prices or facts worth checking, and what the customer should take away. Keep it under 200 words. Only use facts from the sources above — do not invent any business, price or number.`;
  if (!withinBudget(FORTYTWO_MODEL_WORK, planPrompt, 600)) {
    return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
  }
  const plan = await chat({ model: FORTYTWO_MODEL_WORK, messages: [{ role: "user", content: planPrompt }], maxTokens: 1000, reasoningEffort: "low" });
  charge(plan, "Researcher", "Turned the brief and what Scout found into a short plan.");
  if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
  steps[steps.length - 1].detail = stripCodeFences(plan.text).slice(0, 400);

  // --- Writer: the report itself. ---
  const writePrompt = `You are Writer, writing a market report for a small business owner in Nigeria. Write in plain, warm, human words — no jargon, no filler. Write the report ENTIRELY in your own words.\n\nThe job: ${brief}\n${deps.revisionNote ? `The customer asked for a change: ${deps.revisionNote}\n` : ""}\nThe plan:\n${stripCodeFences(plan.text)}\n\n--- SOURCES (fact-checking only — do NOT copy, paste or quote them) ---\n${sourceText}\n--- END OF SOURCES ---\n\nWrite the report as markdown with these parts:\n- A short summary (2–3 sentences): what you found, in plain words.\n- The businesses or options found, each with what they do and any price you actually found. If a price was not in the sources, write "price not listed" — never guess a price.\n- What it means for the customer: which option fits what kind of business, and why.\n- Things to watch out for: anything the sources disagree on, or that could not be checked.\n- Sources: list them by number and title with their link, exactly as given above.\n\nRules: under 800 words. Every fact must come from the sources above — do not invent any business, price, number or fact. If something is not in the sources, say so. Never paste the source text into the report.`;
  if (!withinBudget(FORTYTWO_MODEL_WORK, writePrompt, 1800)) {
    return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
  }
  const draft = await chat({ model: FORTYTWO_MODEL_WORK, messages: [{ role: "user", content: writePrompt }], maxTokens: 1800 });
  charge(draft, "Writer", "Wrote the report from the plan and the sources.");
  if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
  steps[steps.length - 1].detail = `About ${draft.text.split(/\s+/).length} words, from ${pages.length} sources.`;
  let report = stripCodeFences(draft.text);

  // --- Analyst: check every number against the sources. ---
  const checkPrompt = `You are Analyst, checking a market report against its sources.\n\nThe report:\n${report}\n\nThe sources:\n${sourceText}\n\nList every number, price and date in the report, and for each one say whether it appears in the sources or not. End with one line: either "ALL NUMBERS CHECK OUT" or "PROBLEMS:" followed by the list of numbers that could not be checked. Do not add new facts.`;
  if (!withinBudget(FORTYTWO_MODEL_WORK, checkPrompt, 800)) {
    return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
  }
  const check = await chat({ model: FORTYTWO_MODEL_WORK, messages: [{ role: "user", content: checkPrompt }], maxTokens: 2000, reasoningEffort: "low" });
  charge(check, "Analyst", "Checked every number, price and date against the sources.");
  if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
  steps[steps.length - 1].detail = stripCodeFences(check.text).slice(-300);

  // --- Auditor: a different model reads it and says pass or fix. ---
  let revisions = 0;
  for (let attempt = 0; attempt <= REPORT_MAX_REVISIONS; attempt++) {
    const auditPrompt = `You are Auditor, reading a market report before it reaches the customer. You are a different model from the one that wrote it.\n\nThe report:\n${report}\n\nThe numbers check:\n${stripCodeFences(check.text)}\n\nThe sources:\n${sourceText}\n\nAnswer with exactly one line first: PASS or FIX. Then, if FIX, say in plain words what is wrong and what must change. Only judge it against the sources — a fact that is in the sources is fine, a fact that is not is a problem.`;
    if (!withinBudget(FORTYTWO_MODEL_AUDIT, auditPrompt, 600)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const audit = await chat({ model: FORTYTWO_MODEL_AUDIT, messages: [{ role: "user", content: auditPrompt }], maxTokens: 1500, reasoningEffort: "low" });
    charge(audit, "Auditor", attempt === 0 ? "Read the report on a different model, before it reaches you." : "Read the revised report again.");
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    const auditText = stripCodeFences(audit.text);
    steps[steps.length - 1].detail = auditText.slice(0, 400);
    // The Auditor may answer "**PASS**" or "PASS — ..." — strip any leading
    // markdown/punctuation before reading the verdict.
    const verdict = auditText.replace(/^[^A-Za-z]+/, "");
    if (/^PASS\b/i.test(verdict)) {
      return { report, sources, steps, totalTokens, totalCostUsd, status: "delivered", revisions };
    }
    if (attempt === REPORT_MAX_REVISIONS) {
      // One revision was already used. Ship it, but say so plainly.
      steps.push({ agent: "Auditor", what: "Still had notes after one revision — the report is shown with them.", detail: auditText.slice(0, 400) });
      return { report, sources, steps, totalTokens, totalCostUsd, status: "delivered", revisions };
    }
    // One free revision: Writer fixes what the Auditor flagged.
    const fixPrompt = `You are Writer. The Auditor read your report and asked for fixes. Fix exactly what it flagged, and nothing else.\n\nThe Auditor's notes:\n${auditText}\n\nThe report:\n${report}\n\nThe sources (only use facts from here):\n${sourceText}\n\nReturn the full corrected report as markdown, same shape as before. Do not invent any fact.`;
    if (!withinBudget(FORTYTWO_MODEL_WORK, fixPrompt, 1800)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const fixed = await chat({ model: FORTYTWO_MODEL_WORK, messages: [{ role: "user", content: fixPrompt }], maxTokens: 1800 });
    charge(fixed, "Writer", "Revised the report once, fixing what the Auditor flagged.");
    steps[steps.length - 1].detail = `Revised to about ${stripCodeFences(fixed.text).split(/\s+/).length} words.`;
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    report = stripCodeFences(fixed.text);
    revisions += 1;
  }
  return { report, sources, steps, totalTokens, totalCostUsd, status: "delivered", revisions };
}
