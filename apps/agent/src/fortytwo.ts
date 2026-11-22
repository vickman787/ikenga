/**
 * FortyTwo Engine — the model provider for Ikenga's agents.
 *
 * FortyTwo is an OpenAI-compatible chat API:
 *   POST https://api.fortytwo.network/v1/chat/completions
 *   GET  https://api.fortytwo.network/v1/models
 * It only writes and reasons — it does not search the web (see search.ts).
 *
 * The key comes from env FORTYTWO_API_KEY, server-side only. It is never
 * written to a file, a log, or the repo. In Vercel it is an env var the
 * user sets in Production; locally it lives in .env (gitignored).
 *
 * Models (prices per 1M tokens, verified from the FortyTwo docs 2026-11-22):
 *   nvidia/nemotron-3.5-super-vl  $0.15 in / $0.45 out  — the cheap workhorse
 *   qwen/qwen3.8-27b              $0.425 in / $2.55 out — the second opinion
 *   deepseek/deepseek-v4.1-flash-1017 $0.30 in / $1.20 out
 */

export const FORTYTWO_BASE_URL = "https://api.fortytwo.network/v1";

/** Writer / Researcher / Analyst — cheapest, good enough for a report. */
export const FORTYTWO_MODEL_WORK = "nvidia/nemotron-3.5-super-vl";
/** Auditor — a different model, so one model never marks its own homework. */
export const FORTYTWO_MODEL_AUDIT = "qwen/qwen3.8-27b";
export const FORTYTWO_MODEL_CHEAP_ALT = "deepseek/deepseek-v4.1-flash-1017";

export const FORTYTWO_PRICES_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  "nvidia/nemotron-3.5-super-vl": { input: 0.15, output: 0.45 },
  "qwen/qwen3.8-27b": { input: 0.425, output: 2.55 },
  "deepseek/deepseek-v4.1-flash-1017": { input: 0.3, output: 1.2 },
};

export interface FortyTwoUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface FortyTwoReply {
  model: string;
  text: string;
  usage: FortyTwoUsage;
  /** Estimated cost of this one call, in USD. */
  costUsd: number;
}

export function estimateCostUsd(model: string, usage: FortyTwoUsage): number {
  const price = FORTYTWO_PRICES_USD_PER_MILLION[model];
  if (!price) return 0;
  const cost = (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Worst-case cost of a call, for the budget check before we spend. */
export function worstCaseCostUsd(model: string, promptTokens: number, maxTokens: number): number {
  return estimateCostUsd(model, { promptTokens, completionTokens: maxTokens, totalTokens: promptTokens + maxTokens });
}

/** Rough token estimate for a prompt (about 4 characters per token). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function resolveFortyTwoKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.FORTYTWO_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "FORTYTWO_API_KEY is not set — the AI is not connected yet. Add it as a server env var (in Vercel: Production env vars), never in chat or in the repo.",
    );
  }
  return key;
}

export interface ChatInput {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  /**
   * How hard the model should think before answering. FortyTwo's models
   * are reasoning models: the thinking tokens come out of maxTokens, so
   * a long prompt with a small maxTokens can spend the whole budget
   * thinking and return no answer at all (seen live 2026-11-22 — the
   * Analyst's 800-token cap was eaten by reasoning). Check/audit calls
   * use "low"; writing calls use the default.
   */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** fetch override for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

/** One chat completion from FortyTwo. Throws on a non-2xx response. */
export async function chatFortyTwo(input: ChatInput, apiKey?: string): Promise<FortyTwoReply> {
  const key = apiKey ?? resolveFortyTwoKey();
  const fetchFn = input.fetchFn ?? fetch;
  const res = await fetchFn(`${FORTYTWO_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 1024,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoning_effort: input.reasoningEffort } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`FortyTwo ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const usage: FortyTwoUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };
  return { model: input.model, text, usage, costUsd: estimateCostUsd(input.model, usage) };
}
