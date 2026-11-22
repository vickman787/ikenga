import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  worstCaseCostUsd,
  approxTokens,
  chatFortyTwo,
  resolveFortyTwoKey,
  FORTYTWO_MODEL_WORK,
  FORTYTWO_MODEL_AUDIT,
} from "./fortytwo.js";

describe("FortyTwo pricing", () => {
  it("prices Nemotron at $0.15 in / $0.45 out per 1M tokens", () => {
    expect(estimateCostUsd("nvidia/nemotron-3.5-super-vl", { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 })).toBeCloseTo(0.6, 6);
  });
  it("prices Qwen higher than Nemotron", () => {
    const usage = { promptTokens: 10_000, completionTokens: 5_000, totalTokens: 15_000 };
    expect(estimateCostUsd("qwen/qwen3.8-27b", usage)).toBeGreaterThan(estimateCostUsd("nvidia/nemotron-3.5-super-vl", usage));
  });
  it("worst-case cost uses max output tokens", () => {
    expect(worstCaseCostUsd(FORTYTWO_MODEL_WORK, 1000, 1800)).toBeGreaterThan(0);
    expect(worstCaseCostUsd(FORTYTWO_MODEL_WORK, 1000, 1800)).toBeLessThan(0.01);
  });
  it("approxTokens is about 4 chars per token", () => {
    expect(approxTokens("abcd".repeat(100))).toBe(100);
  });
  it("the Auditor uses a different model from the Writer", () => {
    expect(FORTYTWO_MODEL_AUDIT).not.toBe(FORTYTWO_MODEL_WORK);
  });
  it("refuses without a key, and never logs it", () => {
    expect(() => resolveFortyTwoKey({})).toThrow("FORTYTWO_API_KEY is not set");
    expect(resolveFortyTwoKey({ FORTYTWO_API_KEY: "  test-key  " })).toBe("test-key");
  });
});

describe("chatFortyTwo (fake fetch)", () => {
  it("returns text, usage and cost", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const reply = await chatFortyTwo(
      { model: FORTYTWO_MODEL_WORK, messages: [{ role: "user", content: "hi" }], fetchFn },
      "fake-key",
    );
    expect(reply.text).toBe("Hello");
    expect(reply.usage.totalTokens).toBe(150);
    expect(reply.costUsd).toBeGreaterThan(0);
    expect(reply.costUsd).toBeLessThan(0.001);
  });
  it("throws a clear error on a failed call", async () => {
    const fetchFn = (async () => new Response("insufficient_quota", { status: 402 })) as typeof fetch;
    await expect(chatFortyTwo({ model: FORTYTWO_MODEL_WORK, messages: [{ role: "user", content: "hi" }], fetchFn }, "fake-key")).rejects.toThrow(
      "FortyTwo 402",
    );
  });
});
