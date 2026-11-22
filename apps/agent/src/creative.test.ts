import { describe, expect, it } from "vitest";
import {
  runCreative,
  runCreativeStage,
  emptyCreativeProgress,
  creativeRevisionProgress,
  sanitizeHtml,
  CREATIVE_MODEL_BUDGET_USD,
  type CreativeProgress,
} from "./creative.js";
import type { FortyTwoReply } from "./fortytwo.js";

/**
 * Fake chat keyed on the role in the prompt. The build replies are
 * generated from the facts in the prompt, so a different brief really
 * does produce different work — the same way the live run does.
 */
function fakeChat(script: Record<string, string | ((prompt: string) => string)>) {
  const calls: { model: string; prompt: string }[] = [];
  const chat = async (input: { model: string; messages: { role: string; content: string }[]; maxTokens?: number }): Promise<FortyTwoReply> => {
    const prompt = input.messages.map((m) => m.content).join("\n");
    calls.push({ model: input.model, prompt });
    const key = Object.keys(script).find((k) => prompt.includes(k)) ?? "default";
    const entry = script[key] ?? script.default ?? "";
    const text = typeof entry === "function" ? entry(prompt) : entry;
    return { model: input.model, text, usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, costUsd: 0.001 };
  };
  return { chat, calls };
}

const businessNameFromPrompt = (prompt: string): string => {
  const m = prompt.match(/"businessName":\s*"([^"]*)"/) ?? prompt.match(/Business: ([^\n]+)/);
  return m?.[1]?.trim() || "The Business";
};

const ADA_FACTS = JSON.stringify({
  businessName: "Ada's Kitchen",
  whatItDoes: "Home cooking and catering in Lekki, Lagos",
  services: ["Jollof rice", "Small chops", "Catering for parties"],
  prices: [
    { item: "Jollof rice", price: "₦2,500", listed: true },
    { item: "Small chops", price: "price not listed", listed: false },
  ],
  contact: "WhatsApp 0803 123 4567, Lekki Phase 1",
  colours: "",
  notes: "",
});

const websiteDeps = () => {
  const { chat, calls } = fakeChat({
    "You are Designer, reading": ADA_FACTS,
    "You are Designer, building": (prompt) => {
      const name = businessNameFromPrompt(prompt);
      return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4;color:#13271C}</style></head><body><h1>${name}</h1><p>Home cooking and catering in Lekki, Lagos</p><h2>What we serve</h2><ul><li>Jollof rice — ₦2,500</li><li>Small chops — price not listed</li><li>Catering for parties</li></ul><p><a href="https://wa.me/2348031234567">WhatsApp 0803 123 4567</a></p><p>Lekki Phase 1</p></body></html>`;
    },
    "You are Analyst": "Jollof rice ₦2,500 — in the facts. Small chops price not listed — fine. WhatsApp 0803 123 4567 — in the facts. ALL FACTS CHECK OUT",
    "You are Auditor": "PASS\nThe website only uses facts from the brief.",
    "asked for fixes": (prompt) => {
      const name = businessNameFromPrompt(prompt);
      return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4;color:#13271C}</style></head><body><h1>${name}</h1><p>Home cooking and catering in Lekki, Lagos</p><h2>What we serve</h2><ul><li>Jollof rice — ₦2,500</li><li>Small chops — price not listed</li><li>Catering for parties</li></ul><p><a href="https://wa.me/2348031234567">WhatsApp 0803 123 4567</a></p><p>Lekki Phase 1, Lagos</p></body></html>`;
    },
  });
  return { chat, calls };
};

const flyerDeps = () => {
  const { chat } = fakeChat({
    "You are Designer, reading": ADA_FACTS,
    "You are Designer, making": (prompt) => {
      const name = businessNameFromPrompt(prompt);
      return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4;color:#13271C}</style></head><body><h1>${name}</h1><p>Home cooking and catering in Lekki</p><table><tr><td>Jollof rice</td><td>₦2,500</td></tr><tr><td>Small chops</td><td>price not listed</td></tr></table><p>Order on WhatsApp 0803 123 4567</p></body></html>`;
    },
    "You are Analyst": "Jollof rice ₦2,500 — in the facts. Small chops price not listed — fine. ALL FACTS CHECK OUT",
    "You are Auditor": "PASS\nThe flyer only uses facts from the brief.",
  });
  return { chat };
};

const slideshowDeps = () => {
  const { chat } = fakeChat({
    "You are Producer, reading": ADA_FACTS,
    "You are Producer, putting together": (prompt) => {
      const name = businessNameFromPrompt(prompt);
      return JSON.stringify({
        slides: [
          { title: `Real food from ${name}`, text: "Home cooking in Lekki, made fresh every day." },
          { title: "What we cook", text: "Jollof rice, small chops, and catering for parties." },
          { title: "Our food", text: "Jollof rice, small chops, catering for your party." },
          { title: "Prices", text: "Jollof rice ₦2,500. Small chops — price not listed." },
          { title: "Order now", text: "WhatsApp 0803 123 4567, Lekki Phase 1." },
        ],
      });
    },
    "You are Analyst": "Jollof rice ₦2,500 — in the facts. Small chops price not listed — fine. ALL FACTS CHECK OUT",
    "You are Auditor": "PASS\nThe slideshow only uses facts from the brief.",
  });
  return { chat };
};

describe("runCreative — website (fake models)", () => {
  it("reads the brief, builds a real page from it, checks it, and delivers", async () => {
    const { chat, calls } = websiteDeps();
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500, small chops, catering for parties. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain("Ada's Kitchen");
    expect(result.html).toContain("Jollof rice");
    expect(result.html).toContain("₦2,500");
    expect(result.html).toContain("price not listed");
    expect(result.html).toContain("0803 123 4567");
    expect(result.html).not.toContain("<script");
    expect(result.facts?.businessName).toBe("Ada's Kitchen");
    expect(result.steps.map((s) => s.agent)).toEqual(["Designer", "Designer", "Analyst", "Auditor"]);
    // Auditor runs on a different model from the Designer.
    const designerModel = calls.find((c) => c.prompt.includes("You are Designer, building"))?.model;
    const auditorModel = calls.find((c) => c.prompt.includes("You are Auditor"))?.model;
    expect(designerModel).not.toBe(auditorModel);
    expect(result.totalCostUsd).toBeLessThan(CREATIVE_MODEL_BUDGET_USD);
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });

  it("a different brief produces a different website", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": JSON.stringify({
        businessName: "Bola's Braids",
        whatItDoes: "Hair braiding in Yaba",
        services: ["Knotless braids", "Cornrows"],
        prices: [{ item: "Knotless braids", price: "₦15,000", listed: true }],
        contact: "Call 0805 987 6543, Yaba",
        colours: "",
        notes: "",
      }),
      "You are Designer, building": (prompt) => {
        const name = businessNameFromPrompt(prompt);
        return `<!DOCTYPE html><html><head><style>body{color:#13271C}</style></head><body><h1>${name}</h1><p>Hair braiding in Yaba</p><p>Knotless braids — ₦15,000</p><p>Call 0805 987 6543</p></body></html>`;
      },
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nOnly facts from the brief.",
    });
    const result = await runCreative(
      { brief: "A one-page website for Bola's Braids in Yaba — knotless braids ₦15,000, cornrows. Call 0805 987 6543.", jobType: "website" },
      { chat },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain("Bola's Braids");
    expect(result.html).toContain("₦15,000");
    expect(result.html).not.toContain("Ada's Kitchen");
    expect(result.html).not.toContain("Jollof rice");
  });

  it("refuses honestly when the brief says nothing usable", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": JSON.stringify({
        businessName: "", whatItDoes: "", services: [], prices: [], contact: "", colours: "", notes: "no usable facts in the brief",
      }),
    });
    const result = await runCreative({ brief: "do something nice", jobType: "website" }, { chat });
    expect(result.status).toBe("refused");
    expect(result.html).toBe("");
    expect(result.reason).toMatch(/did not say what the business is/);
  });

  it("revises once when the Auditor says FIX, then delivers", async () => {
    let auditorCalls = 0;
    const { chat } = websiteDeps();
    const countingChat = async (input: Parameters<typeof chat>[0]) => {
      if (input.messages[0].content.includes("You are Auditor")) {
        auditorCalls += 1;
        if (auditorCalls === 1) {
          return { model: input.model, text: "FIX\nThe website needs the address shown near the contact.", usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, costUsd: 0.001 };
        }
        return { model: input.model, text: "PASS\nFixed.", usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 }, costUsd: 0.001 };
      }
      return chat(input);
    };
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat: countingChat },
    );
    expect(result.status).toBe("delivered");
    expect(result.revisions).toBe(1);
    expect(auditorCalls).toBe(2);
  });

  it("refuses instead of spending past the $0.50 cap", async () => {
    const { chat, calls } = fakeChat({
      "You are Designer, reading": ADA_FACTS,
      "You are Designer, building": (prompt) => {
        const name = businessNameFromPrompt(prompt);
        return `<!DOCTYPE html><html><body><h1>${name}</h1><p>Home cooking in Lekki</p></body></html>`;
      },
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nFine.",
    });
    // Every call costs $0.60 — past the cap on the first call's worst case.
    const expensiveChat = async (input: Parameters<typeof chat>[0]): Promise<FortyTwoReply> => {
      const reply = await chat(input);
      return { ...reply, costUsd: 0.6, usage: { promptTokens: 100000, completionTokens: 100000, totalTokens: 200000 } };
    };
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki.", jobType: "website" },
      { chat: expensiveChat },
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/\$0\.50/);
    // It stopped after the one call that overspent — it did not keep going.
    expect(calls.length).toBe(1);
  });
});

describe("runCreative — flyers (fake models)", () => {
  it("builds a printable flyer with prices from the brief, and 'price not listed' where the brief gave none", async () => {
    const { chat } = flyerDeps();
    const result = await runCreative(
      { brief: "A flyer for Ada's Kitchen — jollof rice ₦2,500, small chops (no price yet). WhatsApp 0803 123 4567.", jobType: "flyers" },
      { chat },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain("Ada's Kitchen");
    expect(result.html).toContain("₦2,500");
    expect(result.html).toContain("price not listed");
    expect(result.html).not.toContain("<script");
    expect(result.steps.map((s) => s.agent)).toEqual(["Designer", "Designer", "Analyst", "Auditor"]);
  });
});

describe("runCreative — promo video (fake models)", () => {
  it("builds a 5-slide motion slideshow from the brief — words, not a video file", async () => {
    const { chat } = slideshowDeps();
    const result = await runCreative(
      { brief: "A short promo for Ada's Kitchen in Lekki — jollof rice ₦2,500, small chops, catering. WhatsApp 0803 123 4567.", jobType: "promo-video" },
      { chat },
    );
    expect(result.status).toBe("delivered");
    expect(result.slides).toHaveLength(5);
    expect(result.slides[0].title).toContain("Ada's Kitchen");
    expect(result.slides.map((s) => s.text).join(" ")).toContain("₦2,500");
    expect(result.slides.map((s) => s.text).join(" ")).toContain("price not listed");
    expect(result.html).toBe("");
    expect(result.steps.map((s) => s.agent)).toEqual(["Producer", "Producer", "Analyst", "Auditor"]);
  });

  it("a different brief produces different slides", async () => {
    const { chat } = fakeChat({
      "You are Producer, reading": JSON.stringify({
        businessName: "Bola's Braids",
        whatItDoes: "Hair braiding in Yaba",
        services: ["Knotless braids"],
        prices: [{ item: "Knotless braids", price: "₦15,000", listed: true }],
        contact: "Call 0805 987 6543",
        colours: "",
        notes: "",
      }),
      "You are Producer, putting together": (prompt) => {
        const name = businessNameFromPrompt(prompt);
        return JSON.stringify({
          slides: [
            { title: `Braids by ${name}`, text: "Hair braiding in Yaba." },
            { title: "What we do", text: "Knotless braids." },
            { title: "Our work", text: "Knotless braids, neat and long-lasting." },
            { title: "Prices", text: "Knotless braids ₦15,000." },
            { title: "Book now", text: "Call 0805 987 6543." },
          ],
        });
      },
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nOnly facts from the brief.",
    });
    const result = await runCreative(
      { brief: "A short promo for Bola's Braids in Yaba — knotless braids ₦15,000. Call 0805 987 6543.", jobType: "promo-video" },
      { chat },
    );
    expect(result.status).toBe("delivered");
    expect(result.slides[0].title).toContain("Bola's Braids");
    expect(result.slides.map((s) => s.text).join(" ")).not.toContain("Ada's Kitchen");
  });
});

describe("runCreativeStage (chunked, one stage per call)", () => {
  it("runs read → build → check → audit, one stage per call, and delivers", async () => {
    const { chat } = websiteDeps();
    let p = emptyCreativeProgress(
      "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.",
      "website",
    );
    expect(p.stage).toBe(1);
    const stages: number[] = [];
    while (p.status === "in-progress" && p.stage !== 0) {
      stages.push(p.stage);
      // Progress survives a JSON round-trip (this is how it is stored
      // between stages on the server).
      p = JSON.parse(JSON.stringify(p)) as CreativeProgress;
      p = await runCreativeStage(p, { chat });
    }
    expect(stages).toEqual([1, 2, 3, 4]);
    expect(p.status).toBe("delivered");
    expect(p.stage).toBe(0);
    expect(p.html).toContain("Ada's Kitchen");
    expect(p.totalCostUsd).toBeLessThan(CREATIVE_MODEL_BUDGET_USD);
  });

  it("a revision restarts at the build stage, reusing the facts", async () => {
    const { chat } = websiteDeps();
    let p = emptyCreativeProgress("A one-page website for Ada's Kitchen.", "website");
    while (p.status === "in-progress" && p.stage !== 0) {
      p = await runCreativeStage(p, { chat });
    }
    expect(p.status).toBe("delivered");
    const revised = creativeRevisionProgress(p, "Make the headline bigger");
    expect(revised.stage).toBe(2);
    expect(revised.facts?.businessName).toBe("Ada's Kitchen");
    expect(revised.html).toBe(p.html);
    // The revision rebuilds from the same facts, without a new read.
    const built = await runCreativeStage(revised, { chat });
    expect(built.stage).toBe(3);
    expect(built.steps.some((s) => s.what.includes("Read the brief again"))).toBe(false);
  });
});

describe("sanitizeHtml", () => {
  it("strips scripts, frames, pictures, forms and event handlers, and keeps the page", () => {
    const dirty = `<!DOCTYPE html><html><head><style>h1{color:#13271C}</style><script>alert(1)</script></head><body onload="steal()"><h1>Ada's Kitchen</h1><img src="https://evil.example/x.png" onerror="steal()"><iframe src="https://evil.example"></iframe><a href="javascript:steal()">click</a><a href="https://wa.me/2348031234567">WhatsApp</a><form action="https://evil.example"><input></form></body></html>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onload");
    expect(clean).not.toContain("onerror");
    expect(clean).not.toContain("<iframe");
    expect(clean).not.toContain("<img");
    expect(clean).not.toContain("<form");
    expect(clean).not.toContain("javascript:");
    expect(clean).toContain("Ada's Kitchen");
    expect(clean).toContain("https://wa.me/2348031234567");
    expect(clean).toContain("<style>h1{color:#13271C}</style>");
  });
});
