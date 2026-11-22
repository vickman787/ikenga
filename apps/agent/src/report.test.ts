import { describe, expect, it } from "vitest";
import { runMarketReport, REPORT_MODEL_BUDGET_USD } from "./report.js";
import type { FortyTwoReply } from "./fortytwo.js";

function fakeChat(script: Record<string, string>) {
  const calls: { model: string; prompt: string }[] = [];
  const chat = async (input: { model: string; messages: { role: string; content: string }[]; maxTokens?: number }): Promise<FortyTwoReply> => {
    const prompt = input.messages.map((m) => m.content).join("\n");
    calls.push({ model: input.model, prompt });
    const key = Object.keys(script).find((k) => prompt.includes(k)) ?? "default";
    const text = script[key] ?? script.default ?? "";
    return { model: input.model, text, usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, costUsd: 0.001 };
  };
  return { chat, calls };
}

const SOURCES = [
  { title: "Paystack", url: "https://example.com/paystack", text: "Paystack is a Nigerian payment company founded in 2015. It charges 1.5% per local transaction." },
  { title: "Flutterwave", url: "https://example.com/flutterwave", text: "Flutterwave is a payments company founded in 2016, based in Lagos and San Francisco." },
];

describe("runMarketReport (fake models + fake search)", () => {
  it("runs Scout → Researcher → Writer → Analyst → Auditor, in order, and delivers", async () => {
    const { chat, calls } = fakeChat({
      "You are Researcher": "Plan: compare Paystack and Flutterwave on fees and reach.",
      "You are Writer": "# Payment options in Nigeria\n\nPaystack charges 1.5% per local transaction. Flutterwave was founded in 2016.\n\nSources:\n1. Paystack\n2. Flutterwave",
      "You are Analyst": "Paystack 1.5% — in sources. Flutterwave 2016 — in sources. ALL NUMBERS CHECK OUT",
      "You are Auditor": "PASS\nThe report only uses facts from the sources.",
    });
    const result = await runMarketReport(
      { brief: "Compare payment options for my shop in Lagos" },
      {
        chat,
        search: async () => [{ title: "Paystack", url: "https://example.com/paystack" }],
        searchBing: async () => [],
        wiki: async () => [],
        fetchPage: async () => SOURCES[0],
      },
    );
    expect(result.status).toBe("delivered");
    expect(result.report).toContain("Paystack charges 1.5%");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.every((s) => s.url.startsWith("https://"))).toBe(true);
    const agents = result.steps.map((s) => s.agent);
    expect(agents).toEqual(["Scout", "Researcher", "Writer", "Analyst", "Auditor"]);
    // Auditor runs on a different model from the Writer.
    const writerModel = calls.find((c) => c.prompt.includes("You are Writer"))?.model;
    const auditorModel = calls.find((c) => c.prompt.includes("You are Auditor"))?.model;
    expect(writerModel).not.toBe(auditorModel);
    expect(result.totalCostUsd).toBeLessThan(REPORT_MODEL_BUDGET_USD);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it("revises once when the Auditor says FIX, then delivers", async () => {
    let writerCalls = 0;
    const { chat } = fakeChat({
      "You are Researcher": "Plan: compare the two.",
      "You are Writer": "# Report\n\nPaystack charges 1.5%.",
      "You are Analyst": "ALL NUMBERS CHECK OUT",
      "You are Auditor": "FIX\nThe report needs a line about who each option fits.",
    });
    const countingChat = async (input: Parameters<typeof chat>[0]) => {
      if (input.messages[0].content.includes("You are Writer")) writerCalls += 1;
      // Second Auditor call passes.
      if (input.messages[0].content.includes("You are Auditor") && writerCalls >= 2) {
        return { model: input.model, text: "PASS\nFixed.", usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, costUsd: 0.001 };
      }
      return chat(input);
    };
    const result = await runMarketReport({ brief: "Compare payment options" }, { chat: countingChat, search: async () => [], searchBing: async () => [], wiki: async () => SOURCES, fetchPage: async () => null });
    expect(result.status).toBe("delivered");
    expect(result.revisions).toBe(1);
    expect(writerCalls).toBe(2);
  });

  it("refuses honestly when Scout finds nothing readable", async () => {
    const { chat } = fakeChat({ default: "unused" });
    const result = await runMarketReport(
      { brief: "asdfqwer zxcv" },
      { chat, search: async () => [], searchBing: async () => [], wiki: async () => [], fetchPage: async () => null },
    );
    expect(result.status).toBe("refused");
    expect(result.report).toBe("");
    expect(result.reason).toMatch(/could not find anything readable/);
    expect(result.steps[0].agent).toBe("Scout");
  });

  it("never spends past the $0.50 budget", async () => {
    const expensiveChat = async (input: { model: string; messages: { role: string; content: string }[]; maxTokens?: number }): Promise<FortyTwoReply> => ({
      model: input.model,
      text: "x".repeat(100),
      usage: { promptTokens: 900_000, completionTokens: 900_000, totalTokens: 1_800_000 },
      costUsd: 0.4,
    });
    const result = await runMarketReport(
      { brief: "Compare payment options" },
      { chat: expensiveChat, search: async () => [], searchBing: async () => [], wiki: async () => SOURCES, fetchPage: async () => null },
    );
    // Each fake call costs $0.40 — the second one takes the run past the
    // $0.50 cap, so it stops there instead of making more calls.
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/\$0.50/);
    expect(result.report).toBe("");
  });
});
