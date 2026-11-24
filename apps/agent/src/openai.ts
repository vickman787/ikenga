/**
 * OpenAI — the model provider for Ikenga's agents.
 *
 * OpenAI's chat API:
 *   POST https://api.openai.com/v1/chat/completions
 *   GET  https://api.openai.com/v1/models
 * It only writes and reasons — it does not search the web (see search.ts).
 *
 * The key comes from env OPENAI_API_KEY, server-side only. It is never
 * written to a file, a log, or the repo. In Vercel it is an env var the
 * user sets in Production; locally it lives in .env (gitignored).
 *
 * Models (prices per 1M tokens, verified from OpenAI's published rates,
 * Nov 2026):
 *   gpt-4o-mini  $0.15 in / $0.60 out  — the cheap workhorse
 *   gpt-4o       $2.50 in / $10.00 out — the stronger second opinion
 *
 * The Auditor is gpt-4o — a different model from the Writer's
 * gpt-4o-mini, so one model never marks its own homework.
 *
 * Switched from FortyTwo on 2026-11-23: the FortyTwo models' output
 * quality was not good enough for a perfect job, and the user has
 * credit in his OpenAI console. The CFO's $0.50-per-job model cap and
 * $3.50 loss floor are unchanged — the price table below drives the
 * same budget check.
 */

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Writer / Researcher / Analyst — cheapest, good enough for a report. */
export const OPENAI_MODEL_WORK = "gpt-4o-mini";
/** Auditor — a different model, so one model never marks its own homework. */
export const OPENAI_MODEL_AUDIT = "gpt-4o";

export const OPENAI_PRICES_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export interface OpenAIUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAIReply {
  model: string;
  text: string;
  usage: OpenAIUsage;
  /** Estimated cost of this one call, in USD. */
  costUsd: number;
}

export function estimateCostUsd(model: string, usage: OpenAIUsage): number {
  const price = OPENAI_PRICES_USD_PER_MILLION[model];
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

export function resolveOpenAIKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.OPENAI_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is not set — the AI is not connected yet. Add it as a server env var (in Vercel: Production env vars), never in chat or in the repo.",
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
   * Accepted for call-site compatibility but NEVER sent: gpt-4o and
   * gpt-4o-mini do not accept `reasoning_effort` — sending it returns
   * a 400. Call sites still pass "low" from the old provider; it is
   * ignored here on purpose.
   */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** fetch override for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

/** One chat completion from OpenAI. Throws on a non-2xx response. */
export async function chatOpenAI(input: ChatInput, apiKey?: string): Promise<OpenAIReply> {
  const key = apiKey ?? resolveOpenAIKey();
  const fetchFn = input.fetchFn ?? fetch;
  // reasoningEffort is deliberately NOT sent (see ChatInput above).
  const res = await fetchFn(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 1024,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const usage: OpenAIUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0,
  };
  return { model: input.model, text, usage, costUsd: estimateCostUsd(input.model, usage) };
}
