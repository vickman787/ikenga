import { describe, expect, it } from "vitest";
import {
  generateImageOpenAI,
  imageCostUsd,
  OPENAI_IMAGE_MODEL,
  OPENAI_IMAGE_PRICE_USD,
} from "./images.js";
import { OPENAI_BASE_URL } from "./openai.js";

const FAKE_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("imageCostUsd", () => {
  it("falls back to the flat $0.009 when the response carries no usage", () => {
    expect(imageCostUsd(undefined)).toBe(OPENAI_IMAGE_PRICE_USD);
    expect(imageCostUsd({})).toBe(OPENAI_IMAGE_PRICE_USD);
  });
  it("computes the cost from usage when present (gpt-image-1.5 rates)", () => {
    // 272 output tokens at $32/1M + 50 input tokens at $5/1M.
    expect(imageCostUsd({ input_tokens: 50, output_tokens: 272 })).toBeCloseTo(0.008954, 6);
  });
});

describe("generateImageOpenAI (fake fetch)", () => {
  const okFetch = (body: unknown, status = 200) =>
    (async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  it("calls the Images API with the right model, size and quality, and returns a data URI", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init ?? {};
      return new Response(
        JSON.stringify({ data: [{ b64_json: FAKE_B64 }], usage: { input_tokens: 50, output_tokens: 272, total_tokens: 322 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await generateImageOpenAI({ prompt: "A photo of jollof rice", fetchFn }, "fake-key");
    expect(seenUrl).toBe(`${OPENAI_BASE_URL}/images/generations`);
    expect(seenUrl).toContain("api.openai.com");
    expect((seenInit.headers as Record<string, string>).Authorization).toBe("Bearer fake-key");
    const body = JSON.parse(String(seenInit.body));
    expect(body.model).toBe(OPENAI_IMAGE_MODEL);
    expect(body.model).toBe("gpt-image-1.5");
    expect(body.size).toBe("1024x1024");
    expect(body.quality).toBe("low");
    expect(body.n).toBe(1);
    expect(body.output_format).toBe("jpeg");
    expect(result.dataUri).toBe(`data:image/jpeg;base64,${FAKE_B64}`);
    expect(result.model).toBe("gpt-image-1.5");
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.costUsd).toBeLessThan(0.02);
  });

  it("falls back to the flat price when the response carries no usage", async () => {
    const result = await generateImageOpenAI(
      { prompt: "A photo of jollof rice", fetchFn: okFetch({ data: [{ b64_json: FAKE_B64 }] }) },
      "fake-key",
    );
    expect(result.costUsd).toBe(OPENAI_IMAGE_PRICE_USD);
  });

  it("throws a clear error on a failed call", async () => {
    const fetchFn = (async () => new Response("insufficient_quota", { status: 402 })) as typeof fetch;
    await expect(generateImageOpenAI({ prompt: "x", fetchFn }, "fake-key")).rejects.toThrow("OpenAI images 402");
  });

  it("throws when the reply carries no picture", async () => {
    const fetchFn = okFetch({ data: [] });
    await expect(generateImageOpenAI({ prompt: "x", fetchFn }, "fake-key")).rejects.toThrow("no picture");
  });

  it("refuses without a key, and never logs it", async () => {
    await expect(generateImageOpenAI({ prompt: "x", fetchFn: okFetch({}) })).rejects.toThrow("OPENAI_API_KEY is not set");
  });
});
