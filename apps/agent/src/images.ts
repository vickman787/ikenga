/**
 * One picture per creative job, made with OpenAI's image model.
 *
 * gpt-image-1 was the model named in the first plan — it was shut down
 * on 2026-10-23 (deprecated 2026-04-22). Its successor gpt-image-1.5
 * is the model now: verified against the live model list on
 * 2026-11-24 (gpt-image-1 is gone from it; gpt-image-1.5, gpt-image-2
 * and gpt-image-2.5/2.6 are there). Low quality at 1024x1024 is
 * enough for a flyer or a slideshow cover, and it is the cheapest
 * full-quality tier.
 *
 * Price (measured live, 2026-11-24): one picture cost 568 output
 * tokens + 79 input tokens — $0.0186 at gpt-image-1.5's rates
 * ($32/1M out, $5/1M in). The published per-image table lists only
 * the 272 image tokens ($0.008704), but the reply also bills the
 * text tokens it spent, so the flat price is $0.019, not $0.009.
 * The Images API reports exact usage, so the cost is computed from
 * the response when it carries usage, and falls back to the flat
 * $0.019 when it does not.
 *
 * The picture comes back as base64 JPEG and is stored as a data URI
 * inside the deliverable — the sandboxed frame stays self-contained
 * and never reaches out to the internet for it. One picture per job,
 * made once at the design stage; a revision reuses it.
 */
import { OPENAI_BASE_URL, resolveOpenAIKey } from "./openai.js";

/** The image model — gpt-image-1's successor (see above). */
export const OPENAI_IMAGE_MODEL = "gpt-image-1.5";
export const OPENAI_IMAGE_SIZE = "1024x1024";
export const OPENAI_IMAGE_QUALITY = "low";

/** Flat fallback price per picture when the response carries no usage. */
export const OPENAI_IMAGE_PRICE_USD = 0.019;

/** gpt-image-1.5 token rates (OpenAI's published rates, Nov 2026). */
export const OPENAI_IMAGE_OUTPUT_USD_PER_MILLION = 32;
export const OPENAI_IMAGE_INPUT_USD_PER_MILLION = 5;

export interface ImageResult {
  usageEstimated?: boolean;
  /** "data:image/jpeg;base64,..." — embedded in the deliverable. */
  dataUri: string;
  /** What this one picture cost, in USD. */
  costUsd: number;
  model: string;
}

/** Cost of one picture from the response usage, or the flat price. */
export function imageCostUsd(usage?: { input_tokens?: number; output_tokens?: number }): number {
  if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined)) {
    return OPENAI_IMAGE_PRICE_USD;
  }
  const cost =
    ((usage.output_tokens ?? 0) * OPENAI_IMAGE_OUTPUT_USD_PER_MILLION +
      (usage.input_tokens ?? 0) * OPENAI_IMAGE_INPUT_USD_PER_MILLION) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export interface GenerateImageInput {
  /** The picture prompt — built from the brief's facts only (see creative.ts). */
  prompt: string;
  /** fetch override for tests (defaults to global fetch). */
  fetchFn?: typeof fetch;
}

/** One picture from OpenAI's Images API. Throws on a non-2xx response. */
export async function generateImageOpenAI(input: GenerateImageInput, apiKey?: string): Promise<ImageResult> {
  const key = apiKey ?? resolveOpenAIKey();
  const fetchFn = input.fetchFn ?? fetch;
  const res = await fetchFn(`${OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt: input.prompt,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      n: 1,
      output_format: "jpeg",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI images ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const data = (await res.json()) as {
    data?: { b64_json?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };
  const b64 = data.data?.[0]?.b64_json ?? "";
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
    throw new Error("OpenAI images: the reply carried no picture");
  }
  return {
    usageEstimated: !data.usage || !Number.isInteger(data.usage.input_tokens) || !Number.isInteger(data.usage.output_tokens),
    dataUri: `data:image/jpeg;base64,${b64}`,
    costUsd: imageCostUsd(data.usage),
    model: OPENAI_IMAGE_MODEL,
  };
}
