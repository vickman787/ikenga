/**
 * The market report — the first job Ikenga can really deliver.
 *
 * Who does what (the same team as the landing page):
 *   Scout      — searches the web (DuckDuckGo Lite + Bing, free, no
 *                key) and finds the pages worth reading. Every fact
 *                comes from a page Reader actually read, with its
 *                link shown.
 *   Reader     — opens the pages Scout found and pulls out the text
 *                that matters for the brief. A page that will not load
 *                is skipped, not faked.
 *   Researcher — turns the brief + what Reader pulled out into a short plan.
 *   Writer     — writes the report, in plain words, only from the sources.
 *   Analyst    — checks every number, price and date against the sources.
 *   Auditor    — reads it on a DIFFERENT model and says pass or fix. If it
 *                says fix, Writer revises once. One revision, then it ships.
 *   Messenger  — packs the finished report and delivers it on the job
 *                page, with its fingerprint (the same one the boss seals
 *                on the escrow before the customer can accept).
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
 * Chunked runs (Step 3): one whole report takes ~100s, and the free
 * hosting plan cuts a request off at 60s. So the run is split into short
 * stages — Scout, then Reader, then plan + write, then the numbers
 * check, then the read-through in two small parts (facts first, then a
 * final read), and a revision + second read-through if the first one
 * asked for fixes.
 * Each stage is one request with ONE model call, saves its work, and
 * says which stage is next. `runReportStage` runs one stage from saved
 * progress; `runMarketReport` just runs the stages one after another,
 * for the local command line. A customer's revision re-runs the write
 * and read-through stages, reusing the pages Reader already read.
 *
 * Why the read-through is two stages: the Auditor used to read the
 * whole report, the numbers check and all the sources in one call on
 * a slow model, and that call regularly ran past the 60s limit — 17
 * straight timeouts on the live site on 2026-11-23, a 20+ minute run.
 * So the report is capped at 500 words, the Auditor now runs on the
 * faster DeepSeek Flash, and its work is split: one short call checks
 * the facts against the sources, a second short call gives the final
 * read. Each call is small enough to finish inside 60s.
 *
 * The chat and search calls are injectable, so tests can run the whole
 * flow with fakes and never spend a cent or touch the network.
 */
import {
  OPENAI_MODEL_AUDIT,
  OPENAI_MODEL_WORK,
  approxTokens,
  chatOpenAI,
  worstCaseCostUsd,
  type OpenAIReply,
} from "./openai.js";
import { fetchPageText, searchBing, searchWeb, searchWikipedia, type SearchResult, type SourcePage } from "./search.js";
import { deliverWork } from "./messenger.js";

export const REPORT_MODEL_BUDGET_USD = 0.5;
export const REPORT_MAX_REVISIONS = 1;

/** Stage numbers. 0 means finished — the report is delivered or refused. */
export const REPORT_STAGE_SCOUT = 1;
/** Reader: open the pages Scout found and pull out what matters. */
export const REPORT_STAGE_READ = 2;
export const REPORT_STAGE_WRITE = 3;
export const REPORT_STAGE_CHECK = 4;
/** Auditor, part 1: check the facts against the sources. */
export const REPORT_STAGE_AUDIT_FACTS = 5;
/** Auditor, part 2: final read — wording, completeness, PASS or FIX. */
export const REPORT_STAGE_AUDIT_FINAL = 6;
/** Writer fixes exactly what the final read flagged (one Nemotron call). */
export const REPORT_STAGE_REVISE = 7;
/** Second read-through of the revised report: facts again. */
export const REPORT_STAGE_REAUDIT_FACTS = 8;
/** Second read-through of the revised report: final read again. */
export const REPORT_STAGE_REAUDIT_FINAL = 9;

/** Plain-words labels for each stage, for the job page. */
export const REPORT_STAGE_LABELS: Record<number, string> = {
  [REPORT_STAGE_SCOUT]: "Scout is looking the market up",
  [REPORT_STAGE_READ]: "Reader is reading the pages Scout found",
  [REPORT_STAGE_WRITE]: "Writer is writing the report",
  [REPORT_STAGE_CHECK]: "Analyst is checking the numbers",
  [REPORT_STAGE_AUDIT_FACTS]: "A different model is checking the facts",
  [REPORT_STAGE_AUDIT_FINAL]: "A different model is giving it a final read",
  [REPORT_STAGE_REVISE]: "Writer is fixing what was flagged",
  [REPORT_STAGE_REAUDIT_FACTS]: "Checking the revised facts again",
  [REPORT_STAGE_REAUDIT_FINAL]: "Giving the revised report a final read",
};

export function reportStageLabel(stage: number): string {
  return REPORT_STAGE_LABELS[stage] ?? "";
}

export interface ReportStep {
  agent: "Scout" | "Reader" | "Researcher" | "Writer" | "Analyst" | "Auditor" | "Messenger";
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

/**
 * Everything a chunked run has done so far, saved after each stage so the
 * next stage can pick it up — even on another server. `stage` is the next
 * stage to run; 0 means the report is delivered or refused.
 */
export interface ReportProgress {
  stage: number;
  brief: string;
  revisionNote?: string;
  /** Candidate pages Scout found, waiting for Reader to read them. */
  candidates: SearchResult[];
  pages: SourcePage[];
  plan: string;
  report: string;
  checkText: string;
  /** What the facts read-through said (FACTS_OK / FACTS_FIX + notes). */
  auditFacts: string;
  /** What the final read said (PASS / FIX + notes). */
  auditFinal: string;
  steps: ReportStep[];
  sources: ReportSource[];
  totalTokens: number;
  totalCostUsd: number;
  revisions: number;
  status: "in-progress" | "delivered" | "refused";
  reason?: string;
  deliveredAt: string;
}

export function emptyReportProgress(brief: string, revisionNote?: string): ReportProgress {
  return {
    stage: REPORT_STAGE_SCOUT,
    brief: brief.trim(),
    revisionNote,
    candidates: [],
    pages: [],
    plan: "",
    report: "",
    checkText: "",
    auditFacts: "",
    auditFinal: "",
    steps: [],
    sources: [],
    totalTokens: 0,
    totalCostUsd: 0,
    revisions: 0,
    status: "in-progress",
    deliveredAt: "",
  };
}

/** A revision starts again at the writing stage, reusing the pages Reader already read. */
export function revisionProgress(previous: ReportProgress, revisionNote: string): ReportProgress {
  return {
    ...emptyReportProgress(previous.brief, revisionNote),
    stage: REPORT_STAGE_WRITE,
    pages: previous.pages,
    sources: previous.sources,
    // The old report stays on the page until the new one is written.
    report: previous.report,
  };
}

export function progressToResult(p: ReportProgress): MarketReportResult {
  return {
    report: p.status === "delivered" ? p.report : "",
    sources: p.sources,
    steps: p.steps,
    totalTokens: p.totalTokens,
    totalCostUsd: p.totalCostUsd,
    status: p.status === "delivered" ? "delivered" : "refused",
    reason: p.reason,
    revisions: p.revisions,
  };
}

export interface RunReportDeps {
  chat?: (input: { model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; maxTokens?: number; reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }) => Promise<OpenAIReply>;
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

/**
 * What Scout searches for, and what Reader keeps: the main topic from
 * the brief, the named terms for Wikipedia (one name at a time), and
 * the words a page must mention to count as a source for this report.
 * Pure — both stages derive the same terms from the same brief.
 */
function reportSearchTerms(brief: string): { mainTopic: string; wikiTerms: string[]; mustMention: string[] } {
  // A long brief returns nothing from Wikipedia and little from the web,
  // so Scout also tries the names inside it: the part after a colon
  // ("Paystack, Flutterwave and Moniepoint") and the capitalised words.
  const afterColon = brief.includes(":") ? brief.split(":").slice(1).join(":").trim() : "";
  // Capitalised words after the first word of the brief (the first word is
  // capitalised just for starting the sentence — it is not a name).
  const named = [...new Set(brief.split(/\s+/).slice(1).filter((w) => /^[A-Z][a-zA-Z]{2,}$/.test(w.replace(/[^a-zA-Z]/g, ""))))].join(" ");
  const keywords = [afterColon, named].map((s) => s.replace(/[^a-zA-Z0-9 ,&]/g, "").trim()).filter(Boolean);
  const mainTopic = keywords[0] ?? brief;
  const wikiTerms = mainTopic
    .split(/[,，&]| and /)
    .map((s) => s.replace(/[^a-zA-Z0-9 ]/g, "").trim())
    .filter((s) => s.length > 2)
    .slice(0, 3);
  const mustMention = [
    ...wikiTerms,
    ...brief.split(/\s+/).filter((w) => w.length > 4).slice(0, 6),
  ]
    .map((w) => w.replace(/[^a-zA-Z0-9 ]/g, "").trim())
    .filter((w) => w.length > 2);
  return { mainTopic, wikiTerms, mustMention };
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

/**
 * Shorter source extracts for the Auditor: the facts read-through only
 * needs enough to check a claim, not the full pages the Writer had.
 * Keeps the audit calls small so they finish inside 60s.
 */
function auditSourcesText(pages: SourcePage[]): string {
  return pages
    .map((p, i) => `[${i + 1}] ${p.title} — ${p.url}\n${p.text.slice(0, 800)}`)
    .join("\n\n");
}

/** Auditor, part 1: are the facts in the report actually in the sources? */
function auditFactsPrompt(report: string, checkText: string, sourceText: string): string {
  return `You are Auditor, checking the facts in a market report before it reaches the customer. You are a different model from the one that wrote it.\n\nThe report:\n${report}\n\nThe numbers check:\n${checkText}\n\nThe sources:\n${sourceText}\n\nAnswer with exactly one line first: FACTS_OK or FACTS_FIX. Then, if FACTS_FIX, list in plain words each fact that is not in the sources, or that the sources disagree with. Only judge facts against the sources — do not judge the writing.`;
}

/** Auditor, part 2: final read — wording, completeness, PASS or FIX. */
function auditFinalPrompt(report: string, checkText: string, factsText: string): string {
  return `You are Auditor, giving a market report its final read before it reaches the customer. You are a different model from the one that wrote it. The facts were already checked against the sources — do not re-check them, use the verdict below.\n\nThe report:\n${report}\n\nThe numbers check:\n${checkText}\n\nThe facts check:\n${factsText}\n\nAnswer with exactly one line first: PASS or FIX. Then, if FIX, say in plain words what is wrong and what must change. Judge the wording and whether the report is complete and clear for a small business owner — a fact the facts check already passed is fine.`;
}

/**
 * Run ONE stage of a market report from saved progress, and return the
 * updated progress (saved by the caller after each stage). A stage is
 * short — at most two model calls — so it fits in a 60s request.
 */
export async function runReportStage(progress: ReportProgress, deps: RunReportDeps = {}): Promise<ReportProgress> {
  const brief = progress.brief.trim();
  const p: ReportProgress = {
    ...progress,
    steps: [...progress.steps],
    pages: [...progress.pages],
    sources: [...progress.sources],
  };
  if (!brief) {
    return { ...p, stage: 0, status: "refused", reason: "There was no brief to work from." };
  }
  if (p.status !== "in-progress" || p.stage === 0) return p;

  const rawChat = deps.chat ?? (async (c) => chatOpenAI(c));
  /** One chat call; if the model answers with nothing (its thinking ate
   * the token budget), try once more with twice the budget. */
  const chat = async (c: Parameters<NonNullable<RunReportDeps["chat"]>>[0]): Promise<OpenAIReply> => {
    const first = await rawChat(c);
    if (first.text.trim().length > 0) return first;
    return rawChat({ ...c, maxTokens: (c.maxTokens ?? 1024) * 2 });
  };
  const search = deps.search ?? searchWeb;
  const searchBingFn = deps.searchBing ?? searchBing;
  const wiki = deps.wiki ?? searchWikipedia;
  const fetchPage = deps.fetchPage ?? fetchPageText;

  const charge = (reply: OpenAIReply, agent: ReportStep["agent"], what: string) => {
    p.totalTokens += reply.usage.totalTokens;
    p.totalCostUsd = Math.round((p.totalCostUsd + reply.costUsd) * 1_000_000) / 1_000_000;
    p.steps.push({ agent, what, detail: "", model: reply.model, tokens: reply.usage.totalTokens, costUsd: reply.costUsd });
  };

  /** Refuse instead of overspending: check the worst case before each call. */
  const withinBudget = (model: string, prompt: string, maxTokens: number): boolean =>
    p.totalCostUsd + worstCaseCostUsd(model, approxTokens(prompt), maxTokens) <= REPORT_MODEL_BUDGET_USD;

  /** Already spent too much (a call cost more than its worst case) — stop now. */
  const overBudget = (): boolean => p.totalCostUsd > REPORT_MODEL_BUDGET_USD;

  const refuse = (reason: string): ReportProgress => ({
    ...p, report: "", stage: 0, status: "refused", reason, deliveredAt: new Date().toISOString(),
  });
  const deliver = (): ReportProgress => {
    // Messenger packs the finished report and delivers it on the job
    // page — its fingerprint is the same one the boss seals on the
    // escrow before the customer can accept.
    p.steps.push(deliverWork({ report: p.report }, "report").step);
    return { ...p, stage: 0, status: "delivered", deliveredAt: new Date().toISOString() };
  };

  // --- Stage 1, Scout: search, and find the pages worth reading. ---
  if (p.stage === REPORT_STAGE_SCOUT) {
    const { mainTopic } = reportSearchTerms(brief);
    const candidates: SearchResult[] = [...p.candidates];
    if (candidates.length === 0) {
      const queries = [...new Set([mainTopic, `${mainTopic} Nigeria`, `${mainTopic} fees`, `${mainTopic} vs`])];
      for (const q of queries) {
        // Bing first (reliable), DuckDuckGo as a backup.
        for (const fn of [searchBingFn, search]) {
          try {
            const found = await fn(q, 5);
            for (const r of found) if (!candidates.some((x) => x.url === r.url)) candidates.push(r);
            if (candidates.length >= 8) break;
          } catch {
            // One failed search never stops the report — Scout tries the next one.
          }
        }
        if (candidates.length >= 8) break;
      }
    }
    p.candidates = candidates;
    p.steps.push({
      agent: "Scout",
      what: `Looked up "${brief}" and found ${candidates.length} ${candidates.length === 1 ? "page" : "pages"} to read.`,
      detail: candidates.length > 0 ? `Found: ${candidates.map((c) => c.title).join("; ")}` : "Nothing came back from the search — so there is nothing to read.",
    });
    return { ...p, stage: REPORT_STAGE_READ };
  }

  // --- Stage 2, Reader: open the pages Scout found and pull out what matters. ---
  if (p.stage === REPORT_STAGE_READ) {
    const { wikiTerms, mustMention } = reportSearchTerms(brief);
    const pages: SourcePage[] = [...p.pages];
    // Wikipedia wants one name at a time — "Paystack, Flutterwave" finds
    // nothing, "Paystack" finds the page. Try the first three named terms.
    for (const term of wikiTerms.length > 0 ? wikiTerms : [brief]) {
      const found = await wiki(term, 1).catch(() => [] as SourcePage[]);
      for (const pp of found) if (!pages.some((x) => x.url === pp.url)) pages.push(pp);
    }
    // Read the web results, but only keep pages that actually mention
    // what the customer asked about — a page that matches the word
    // "compare" and nothing else is not a source for this report. A page
    // passes if it mentions any named business or any content word.
    const mentionsTopic = (text: string) => {
      const lower = text.toLowerCase();
      return mustMention.some((t) => lower.includes(t.toLowerCase()));
    };
    for (const r of p.candidates) {
      if (pages.length >= 6) break;
      const page = await fetchPage(r.url);
      if (!page) continue;
      if (!mentionsTopic(page.text) && !mentionsTopic(r.title)) continue;
      if (pages.some((pp) => pp.url === page.url)) continue;
      pages.push({ title: r.title, url: page.url, text: page.text });
    }
    p.pages = pages;
    p.sources = pages.map((pg) => ({ title: pg.title, url: pg.url }));
    p.steps.push({
      agent: "Reader",
      what: `Read ${pages.length} ${pages.length === 1 ? "page" : "pages"} and pulled out what matters for your brief.`,
      detail: pages.length > 0 ? `Sources: ${p.sources.map((s) => s.title).join("; ")}` : "Nothing readable came back — so there is no report to write from.",
    });
    if (pages.length === 0) {
      return refuse("Neither Scout nor Reader could find anything readable about this — so there is no report to write from. Try a clearer brief, with the business or market named.");
    }
    return { ...p, stage: REPORT_STAGE_WRITE };
  }

  const sourceText = sourcesText(p.pages);

  // --- Stage 2, Researcher + Writer: a short plan, then the report. ---
  if (p.stage === REPORT_STAGE_WRITE) {
    const planPrompt = `You are Researcher, planning a short market report for a small business owner in Nigeria.\n\nThe job: ${brief}\n\nWhat Reader pulled out of the pages (only use facts from here):\n${sourceText}\n\nWrite a short plan: the businesses or options to compare, the prices or facts worth checking, and what the customer should take away. Keep it under 200 words. Only use facts from the sources above — do not invent any business, price or number.`;
    if (!withinBudget(OPENAI_MODEL_WORK, planPrompt, 600)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const plan = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: planPrompt }], maxTokens: 1000, reasoningEffort: "low" });
    charge(plan, "Researcher", "Turned the brief and what Reader pulled out into a short plan.");
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    p.plan = stripCodeFences(plan.text);
    p.steps[p.steps.length - 1].detail = p.plan.slice(0, 400);

    const writePrompt = `You are Writer, writing a market report for a small business owner in Nigeria. Write in plain, warm, human words — no jargon, no filler. Write the report ENTIRELY in your own words.\n\nThe job: ${brief}\n${p.revisionNote ? `The customer asked for a change: ${p.revisionNote}\n` : ""}\nThe plan:\n${p.plan}\n\n--- SOURCES (fact-checking only — do NOT copy, paste or quote them) ---\n${sourceText}\n--- END OF SOURCES ---\n\nWrite the report as markdown with these parts:\n- A short summary (2–3 sentences): what you found, in plain words.\n- The businesses or options found, each with what they do and any price you actually found. If a price was not in the sources, write "price not listed" — never guess a price.\n- What it means for the customer: which option fits what kind of business, and why.\n- Things to watch out for: anything the sources disagree on, or that could not be checked.\n- Sources: list them by number and title with their link, exactly as given above.\n\nRules: under 500 words. Every fact must come from the sources above — do not invent any business, price, number or fact. If something is not in the sources, say so. Never paste the source text into the report.`;
    if (!withinBudget(OPENAI_MODEL_WORK, writePrompt, 1800)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const draft = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: writePrompt }], maxTokens: 1200 });
    charge(draft, "Writer", "Wrote the report from the plan and the sources.");
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    p.steps[p.steps.length - 1].detail = `About ${draft.text.split(/\s+/).length} words, from ${p.pages.length} sources.`;
    p.report = stripCodeFences(draft.text);
    return { ...p, stage: REPORT_STAGE_CHECK };
  }

  // --- Stage 3, Analyst: check every number against the sources. ---
  if (p.stage === REPORT_STAGE_CHECK) {
    const checkPrompt = `You are Analyst, checking a market report against its sources.\n\nThe report:\n${p.report}\n\nThe sources:\n${sourceText}\n\nList every number, price and date in the report, and for each one say whether it appears in the sources or not. End with one line: either "ALL NUMBERS CHECK OUT" or "PROBLEMS:" followed by the list of numbers that could not be checked. Do not add new facts.`;
    if (!withinBudget(OPENAI_MODEL_WORK, checkPrompt, 800)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const check = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: checkPrompt }], maxTokens: 2000, reasoningEffort: "low" });
    charge(check, "Analyst", "Checked every number, price and date against the sources.");
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    p.checkText = stripCodeFences(check.text);
    p.steps[p.steps.length - 1].detail = p.checkText.slice(-300);
    return { ...p, stage: REPORT_STAGE_AUDIT_FACTS };
  }

  // --- Stages 4 and 7, Auditor part 1: check the facts, one short call. ---
  if (p.stage === REPORT_STAGE_AUDIT_FACTS || p.stage === REPORT_STAGE_REAUDIT_FACTS) {
    const isReaudit = p.stage === REPORT_STAGE_REAUDIT_FACTS;
    const prompt = auditFactsPrompt(p.report, p.checkText, auditSourcesText(p.pages));
    if (!withinBudget(OPENAI_MODEL_AUDIT, prompt, 600)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const facts = await chat({ model: OPENAI_MODEL_AUDIT, messages: [{ role: "user", content: prompt }], maxTokens: 600, reasoningEffort: "low" });
    charge(facts, "Auditor", isReaudit ? "Checked the revised facts against the sources." : "Checked every fact against the sources.");
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    const factsText = stripCodeFences(facts.text);
    p.auditFacts = factsText;
    p.steps[p.steps.length - 1].detail = factsText.slice(0, 400);
    return { ...p, stage: isReaudit ? REPORT_STAGE_REAUDIT_FINAL : REPORT_STAGE_AUDIT_FINAL };
  }

  // --- Stages 5 and 8, Auditor part 2: final read, PASS or FIX. ---
  // The facts are already checked, so this call gets no sources — just
  // the report, the numbers check and the facts verdict. Small in, small
  // out, so it finishes inside 60s.
  if (p.stage === REPORT_STAGE_AUDIT_FINAL || p.stage === REPORT_STAGE_REAUDIT_FINAL) {
    const isReaudit = p.stage === REPORT_STAGE_REAUDIT_FINAL;
    const prompt = auditFinalPrompt(p.report, p.checkText, p.auditFacts);
    if (!withinBudget(OPENAI_MODEL_AUDIT, prompt, 800)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const audit = await chat({ model: OPENAI_MODEL_AUDIT, messages: [{ role: "user", content: prompt }], maxTokens: 800, reasoningEffort: "low" });
    charge(audit, "Auditor", isReaudit ? "Read the revised report again." : "Read the report on a different model, before it reaches you.");
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    const auditText = stripCodeFences(audit.text);
    p.auditFinal = auditText;
    p.steps[p.steps.length - 1].detail = auditText.slice(0, 400);
    // The Auditor may answer "**PASS**" or "PASS — ..." — strip any leading
    // markdown/punctuation before reading the verdict.
    const verdict = auditText.replace(/^[^A-Za-z]+/, "");
    if (/^PASS\b/i.test(verdict)) {
      return deliver();
    }
    if (isReaudit) {
      // One revision was already used. Ship it, but say so plainly.
      p.steps.push({ agent: "Auditor", what: "Still had notes after one revision — the report is shown with them.", detail: auditText.slice(0, 400) });
      return deliver();
    }
    // One free revision: the next stage (a Writer call of its own) fixes
    // exactly what the final read flagged.
    return { ...p, stage: REPORT_STAGE_REVISE };
  }

  // --- Stage 6, Writer revises once, fixing what the final read flagged. ---
  if (p.stage === REPORT_STAGE_REVISE) {
    const fixPrompt = `You are Writer. The Auditor read your report and asked for fixes. Fix exactly what it flagged, and nothing else.\n\nThe Auditor's notes:\n${p.auditFinal}\n\nThe facts check said:\n${p.auditFacts}\n\nThe report:\n${p.report}\n\nThe sources (only use facts from here):\n${sourceText}\n\nReturn the full corrected report as markdown, same shape as before, under 500 words. Do not invent any fact.`;
    if (!withinBudget(OPENAI_MODEL_WORK, fixPrompt, 1200)) {
      return refuse("The report would cost more than the $0.50 set aside for it, so it stopped before spending anything.");
    }
    const fixed = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: fixPrompt }], maxTokens: 1200 });
    charge(fixed, "Writer", "Revised the report once, fixing what the Auditor flagged.");
    p.steps[p.steps.length - 1].detail = `Revised to about ${stripCodeFences(fixed.text).split(/\s+/).length} words.`;
    if (overBudget()) return refuse("The report already cost more than the $0.50 set aside for it, so it stopped instead of spending more.");
    p.report = stripCodeFences(fixed.text);
    p.revisions += 1;
    return { ...p, stage: REPORT_STAGE_REAUDIT_FACTS };
  }

  return p;
}

/** Run the whole report, one stage at a time (the local command line). */
export async function runMarketReport(input: RunReportInput, deps: RunReportDeps = {}): Promise<MarketReportResult> {
  const brief = input.brief.trim();
  if (!brief) {
    return { report: "", sources: [], steps: [], totalTokens: 0, totalCostUsd: 0, status: "refused", reason: "There was no brief to work from.", revisions: 0 };
  }
  let progress = emptyReportProgress(brief, deps.revisionNote);
  if (deps.existingSources && deps.existingSources.length > 0) {
    // A revision reuses the pages Reader already read — no new search,
    // but the Scout and Reader steps still show what was found and read.
    progress.pages = deps.existingSources;
    progress.sources = progress.pages.map((pg) => ({ title: pg.title, url: pg.url }));
    progress.steps.push(
      {
        agent: "Scout",
        what: `Looked up "${brief}" and found ${progress.pages.length} ${progress.pages.length === 1 ? "page" : "pages"} to read.`,
        detail: `Found: ${progress.sources.map((s) => s.title).join("; ")}`,
      },
      {
        agent: "Reader",
        what: `Read ${progress.pages.length} ${progress.pages.length === 1 ? "page" : "pages"} and pulled out what matters for your brief.`,
        detail: `Sources: ${progress.sources.map((s) => s.title).join("; ")}`,
      },
    );
    progress.stage = REPORT_STAGE_WRITE;
  }
  while (progress.status === "in-progress" && progress.stage !== 0) {
    progress = await runReportStage(progress, deps);
  }
  return progressToResult(progress);
}
