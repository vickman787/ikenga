import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  worstCaseCostUsd,
  approxTokens,
  chatOpenAI,
  resolveOpenAIKey,
  OPENAI_BASE_URL,
  OPENAI_MODEL_WORK,
  OPENAI_MODEL_AUDIT,
} from "./openai.js";

describe("OpenAI pricing", () => {
  it("prices gpt-4o-mini at $0.15 in / $0.60 out per 1M tokens", () => {
    expect(estimateCostUsd("gpt-4o-mini", { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 })).toBeCloseTo(0.75, 6);
  });
  it("prices gpt-4o higher than gpt-4o-mini", () => {
    const usage = { promptTokens: 10_000, completionTokens: 5_000, totalTokens: 15_000 };
    expect(estimateCostUsd("gpt-4o", usage)).toBeGreaterThan(estimateCostUsd("gpt-4o-mini", usage));
  });
  it("worst-case cost uses max output tokens", () => {
    expect(worstCaseCostUsd(OPENAI_MODEL_WORK, 1000, 1800)).toBeGreaterThan(0);
    expect(worstCaseCostUsd(OPENAI_MODEL_WORK, 1000, 1800)).toBeLessThan(0.01);
  });
  it("approxTokens is about 4 chars per token", () => {
    expect(approxTokens("abcd".repeat(100))).toBe(100);
  });
  it("the Auditor uses a different model from the Writer", () => {
    expect(OPENAI_MODEL_AUDIT).not.toBe(OPENAI_MODEL_WORK);
  });
  it("refuses without a key, and never logs it", () => {
    expect(() => resolveOpenAIKey({})).toThrow("OPENAI_API_KEY is not set");
    expect(resolveOpenAIKey({ OPENAI_API_KEY: "  test-key  " })).toBe("test-key");
  });
});

describe("chatOpenAI (fake fetch)", () => {
  it("returns text, usage and cost", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const reply = await chatOpenAI(
      { model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: "hi" }], fetchFn },
      "fake-key",
    );
    expect(reply.text).toBe("Hello");
    expect(reply.usage.totalTokens).toBe(150);
    expect(reply.costUsd).toBeGreaterThan(0);
    expect(reply.costUsd).toBeLessThan(0.001);
  });
  it("sends Bearer auth to api.openai.com with the right model and max_tokens", async () => {
    let seenUrl = "";
    let seenInit: RequestInit = {};
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init ?? {};
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    await chatOpenAI(
      { model: OPENAI_MODEL_AUDIT, messages: [{ role: "user", content: "hi" }], maxTokens: 600, fetchFn },
      "fake-key",
    );
    expect(seenUrl).toBe(`${OPENAI_BASE_URL}/chat/completions`);
    expect(seenUrl).toContain("api.openai.com");
    expect((seenInit.headers as Record<string, string>).Authorization).toBe("Bearer fake-key");
    const body = JSON.parse(String(seenInit.body));
    expect(body.model).toBe("gpt-4o");
    expect(body.max_tokens).toBe(600);
  });
  it("never sends reasoning_effort — gpt-4o and gpt-4o-mini reject it with a 400", async () => {
    let seenBody = "";
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Hello" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    // Call sites still pass reasoningEffort: "low" from the old provider;
    // the client must accept it and drop it, never send it.
    await chatOpenAI(
      { model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: "hi" }], maxTokens: 600, reasoningEffort: "low", fetchFn },
      "fake-key",
    );
    expect(JSON.parse(seenBody)).not.toHaveProperty("reasoning_effort");
  });
  it("throws a clear error on a failed call", async () => {
    const fetchFn = (async () => new Response("insufficient_quota", { status: 402 })) as typeof fetch;
    await expect(chatOpenAI({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: "hi" }], fetchFn }, "fake-key")).rejects.toThrow(
      "OpenAI 402",
    );
  });
});

it('refuses unconfigured model prices before making a paid request', async()=>{
 let requests=0;
 const fetchFn=(async()=>{requests++;return new Response('{}');}) as typeof fetch;
 await expect(chatOpenAI({model:'unknown-model',messages:[{role:'user',content:'hi'}],fetchFn},'fake-key')).rejects.toThrow('No configured price');
 expect(requests).toBe(0);
});
it('sends a strict schema and rejects truncated text while accounting for its usage', async()=>{
 let body:any;let signal:AbortSignal|undefined;
 const fetchFn=(async(_url:unknown,init?:RequestInit)=>{body=JSON.parse(String(init?.body));signal=init?.signal as AbortSignal;return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'<html>incomplete'}}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}));}) as typeof fetch;
 const result=await chatOpenAI({model:OPENAI_MODEL_WORK,messages:[{role:'user',content:'Return JSON'}],responseSchema:{name:'check',schema:{type:'object',properties:{},required:[],additionalProperties:false}},fetchFn},'fake-key');
 expect(result.text).toBe('');expect(result.costUsd).toBeGreaterThan(0);expect(body.response_format.json_schema.strict).toBe(true);expect(signal).toBeInstanceOf(AbortSignal);
});

it('reserves a nonzero worst-case cost when usage is omitted',async()=>{
 const fetchFn=(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Hello'}}]}))) as typeof fetch;
 const result=await chatOpenAI({model:OPENAI_MODEL_WORK,messages:[{role:'user',content:'hi'}],fetchFn},'fake-key');
 expect(result.costUsd).toBeGreaterThan(0);expect(result.usage.completionTokens).toBe(1024);
});
