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
  if (!price) throw new Error("No configured price for model: " + model);
  const cost = (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Worst-case cost of a call, for the budget check before we spend. */
export function worstCaseCostUsd(model: string, promptTokens: number, maxTokens: number): number {
  return estimateCostUsd(model, { promptTokens, completionTokens: maxTokens, totalTokens: promptTokens + maxTokens });
}

/** Rough token estimate for a prompt (about 4 characters per token). */
/** Conservative byte-level reservation, including chat framing overhead. */
export function promptTokenUpperBound(text: string): number { return new TextEncoder().encode(text).length + 256; }

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
  responseSchema?: { name: string; schema: Record<string, unknown> };
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
  // Validate pricing before sending a paid request.
  estimateCostUsd(input.model, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  const res = await fetchFn(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: input.model,
      ...(input.responseSchema ? { response_format: { type: "json_schema", json_schema: { ...input.responseSchema, strict: true } } } : {}),
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
    choices?: { finish_reason?: string; message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const choice = data.choices?.[0];
  // Still account for usage, but never accept a truncated or filtered artifact.
  const text = choice?.finish_reason && choice.finish_reason !== "stop" ? "" : choice?.message?.content ?? "";
  const measured = data.usage;
  const valid = measured && Number.isInteger(measured.prompt_tokens) && measured.prompt_tokens! >= 0 && Number.isInteger(measured.completion_tokens) && measured.completion_tokens! >= 0;
  // Missing usage must never make a paid call appear free.
  const usage: OpenAIUsage = valid ? {
    promptTokens: measured.prompt_tokens!, completionTokens: measured.completion_tokens!, totalTokens: measured.prompt_tokens! + measured.completion_tokens!,
  } : {
    promptTokens: promptTokenUpperBound(input.messages.map(m=>m.content).join("\n")), completionTokens: input.maxTokens ?? 1024,
    totalTokens: promptTokenUpperBound(input.messages.map(m=>m.content).join("\n")) + (input.maxTokens ?? 1024),
  };
  return { model: input.model, text, usage, costUsd: estimateCostUsd(input.model, usage) };
}
