import { describe, expect, it } from "vitest";
import {
  runCreative,
  runCreativeStage,
  emptyCreativeProgress,
  creativeRevisionProgress,
  sanitizeHtml,
  extractHtmlDocument,
  pruneUnknownPriceRows,
  buildImagePrompt,
  insertHeroImage,
  HERO_IMAGE_MARKER,
  CREATIVE_MODEL_BUDGET_USD,
  type CreativeProgress,
  type CreativeFacts,
} from "./creative.js";
import type { OpenAIReply } from "./openai.js";
import type { ImageResult } from "./images.js";

/**
 * Fake chat keyed on the role in the prompt. The build replies are
 * generated from the facts in the prompt, so a different brief really
 * does produce different work — the same way the live run does.
 */
function fakeChat(script: Record<string, string | ((prompt: string) => string)>) {
  const calls: { model: string; prompt: string }[] = [];
  const chat = async (input: { model: string; messages: { role: string; content: string }[]; maxTokens?: number }): Promise<OpenAIReply> => {
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
      return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4;color:#13271C}.hero img{width:100%;border-radius:16px}.card{border:1px solid #E8E4D8;border-radius:12px;padding:16px}</style></head><body><header class="hero">${HERO_IMAGE_MARKER}<h1>${name}</h1><p>Home cooking and catering in Lekki, Lagos</p><p><a href="https://wa.me/2348031234567">WhatsApp 0803 123 4567</a></p></header><section><h2>What we serve</h2><div class="card"><h3>Jollof rice</h3><p>₦2,500</p></div><div class="card"><h3>Small chops</h3><p>price not listed</p></div><div class="card"><h3>Catering for parties</h3></div></section><section><h2>Hours</h2><p>Lekki Phase 1</p></section><section><h2>Call and order</h2><p><a href="https://wa.me/2348031234567">WhatsApp 0803 123 4567</a></p></section></body></html>`;
    },
    "You are Analyst": "Jollof rice ₦2,500 — in the facts. Small chops price not listed — fine. WhatsApp 0803 123 4567 — in the facts. ALL FACTS CHECK OUT",
    "You are Auditor": "PASS\nThe website only uses facts from the brief.",
    "asked for fixes": (prompt) => {
      const name = businessNameFromPrompt(prompt);
      return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4;color:#13271C}.hero img{width:100%;border-radius:16px}</style></head><body><header class="hero"><h1>${name}</h1><p>Home cooking and catering in Lekki, Lagos</p></header><section><h2>What we serve</h2><ul><li>Jollof rice — ₦2,500</li><li>Small chops — price not listed</li><li>Catering for parties</li></ul></section><p>Lekki Phase 1, Lagos</p></body></html>`;
    },
  });
  return { chat, calls };
};

const flyerDeps = () => {
  const { chat, calls } = fakeChat({
    "You are Designer, reading": ADA_FACTS,
    "You are Designer, making": (prompt) => {
      const name = businessNameFromPrompt(prompt);
      return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4;color:#13271C}</style></head><body><h1>${name}</h1><p>Home cooking and catering in Lekki</p><table><tr><td>Jollof rice</td><td>₦2,500</td></tr><tr><td>Small chops</td><td>price not listed</td></tr></table><p>Order on WhatsApp 0803 123 4567</p></body></html>`;
    },
    "You are Analyst": "Jollof rice ₦2,500 — in the facts. Small chops price not listed — fine. ALL FACTS CHECK OUT",
    "You are Auditor": "PASS\nThe flyer only uses facts from the brief.",
  });
  return { chat, calls };
};

const slideshowDeps = () => {
  const { chat, calls } = fakeChat({
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
  return { chat, calls };
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
    expect(result.steps.map((s) => s.agent)).toEqual(["Designer", "Designer", "Analyst", "Auditor", "Messenger"]);
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
    const expensiveChat = async (input: Parameters<typeof chat>[0]): Promise<OpenAIReply> => {
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
    expect(result.steps.map((s) => s.agent)).toEqual(["Designer", "Designer", "Analyst", "Auditor", "Messenger"]);
  });

  it("drops an invented price row even when the model writes one", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": ADA_FACTS,
      "You are Designer, making": (prompt) => {
        const name = businessNameFromPrompt(prompt);
        return `<!DOCTYPE html><html><body><h1>${name}</h1><table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody><tr><td>Jollof rice</td><td>₦2,500</td></tr><tr><td>Small chops</td><td>price not listed</td></tr></tbody><tfoot><tr><td>Special Offers</td><td>price not listed</td></tr></tfoot></table></body></html>`;
      },
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nFine.",
    });
    const result = await runCreative(
      { brief: "A flyer for Ada's Kitchen — jollof rice ₦2,500, small chops (no price yet). WhatsApp 0803 123 4567.", jobType: "flyers" },
      { chat },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain("Jollof rice");
    expect(result.html).toContain("Small chops");
    expect(result.html).not.toContain("Special Offers");
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
    expect(result.steps.map((s) => s.agent)).toEqual(["Producer", "Producer", "Analyst", "Auditor", "Messenger"]);
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

describe("build prompts — the no-invention rule", () => {
  it("the website, flyer and slideshow prompts all forbid extra rows, offers and items", async () => {
    const website = websiteDeps();
    await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat: website.chat },
    );
    const websiteBuild = website.calls.find((c) => c.prompt.includes("You are Designer, building"))?.prompt ?? "";
    expect(websiteBuild).toContain("never add an extra");

    const flyer = flyerDeps();
    await runCreative(
      { brief: "A flyer for Ada's Kitchen — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "flyers" },
      { chat: flyer.chat },
    );
    const flyerBuild = flyer.calls.find((c) => c.prompt.includes("You are Designer, making"))?.prompt ?? "";
    expect(flyerBuild).toContain("never add an extra");
    expect(flyerBuild).toContain("list exactly the items in the facts");

    const slideshow = slideshowDeps();
    await runCreative(
      { brief: "A short promo for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "promo-video" },
      { chat: slideshow.chat },
    );
    const slideshowBuild = slideshow.calls.find((c) => c.prompt.includes("You are Producer, putting together"))?.prompt ?? "";
    expect(slideshowBuild).toContain("never add an extra");
  });
});

describe("website prompt — the hero design", () => {
  it("the website build prompt asks for a hero, service cards, hours, and a big call button", async () => {
    const { chat, calls } = websiteDeps();
    await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat },
    );
    const build = calls.find((c) => c.prompt.includes("You are Designer, building"))?.prompt ?? "";
    expect(build).toContain("hero");
    expect(build).toContain(".hero img");
    expect(build).toContain("one card per service");
    expect(build).toContain("big call/order button");
    expect(build).toContain("Hours and place");
    expect(build).toContain("print cleanly");
    expect(build).toContain("720px");
    // The design rules ride with the no-invention rule.
    expect(build).toContain("never add an extra");
    expect(build).toContain("Only the services in the facts");
  });

  it("a build that comes back with commentary after </html> delivers a clean page", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": ADA_FACTS,
      "You are Designer, building": () =>
        `<!DOCTYPE html><html><head><style>body{background:#FBF9F4}</style></head><body><header class="hero"><h1>Ada's Kitchen</h1>${HERO_IMAGE_MARKER}<p>Home cooking in Lekki</p></header></body></html>\n\nIn this corrected version:\n- The picture is now in the hero.`,
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nFine.",
    });
    const { image } = fakeImage();
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain("Ada's Kitchen");
    expect(result.html).toContain(`<img src="${FAKE_IMG}"`);
    expect(result.html).not.toContain("In this corrected version");
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

  it("keeps a picture only when it is our own embedded data URI", () => {
    const ours = `<h1>Ada's Kitchen</h1><img src="data:image/jpeg;base64,/9j/FAKEBASE64==" alt="Ada's Kitchen">`;
    const clean = sanitizeHtml(ours);
    expect(clean).toContain('<img src="data:image/jpeg;base64,/9j/FAKEBASE64=="');
    expect(clean).toContain("Ada's Kitchen");
  });

  it("strips an external picture, a javascript: picture, and a handler on our own picture", () => {
    const external = `<img src="https://evil.example/x.png">`;
    expect(sanitizeHtml(external)).not.toContain("<img");
    const js = `<img src="javascript:steal()">`;
    expect(sanitizeHtml(js)).not.toContain("<img");
    const handler = `<img src="data:image/jpeg;base64,/9j/FAKE==" onerror="steal()" alt="x">`;
    const clean = sanitizeHtml(handler);
    expect(clean).toContain('<img src="data:image/jpeg;base64,/9j/FAKE=="');
    expect(clean).not.toContain("onerror");
  });

  it("removes a <title> with its text — the text would print twice", () => {
    const dirty = `<!DOCTYPE html><html><head><title>Ada's Kitchen</title><style>h1{color:#13271C}</style></head><body><h1>Ada's Kitchen</h1><p>Food.</p></body></html>`;
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toContain("<title");
    // The name appears once — the headline — not twice.
    expect(clean.match(/Ada's Kitchen/g)?.length).toBe(1);
    expect(clean).toContain("<h1>Ada's Kitchen</h1>");
  });
});

describe("extractHtmlDocument", () => {
  const page = `<!DOCTYPE html><html><head><style>h1{color:#13271C}</style></head><body><h1>Ada's Kitchen</h1><p>Food.</p></body></html>`;

  it("drops words before the page and commentary after it", () => {
    const reply = `Here is your website:\n\n\`\`\`html\n${page}\n\`\`\`\n\nIn this corrected version:\n- The picture is now in the hero.`;
    const out = extractHtmlDocument(reply);
    expect(out).toBe(page);
    expect(out).not.toContain("Here is your website");
    expect(out).not.toContain("In this corrected version");
  });

  it("leaves a clean page untouched", () => {
    expect(extractHtmlDocument(page)).toBe(page);
  });

  it("returns the text as-is when there is no complete document", () => {
    const fragment = `<h1>Ada's Kitchen</h1><p>Food.</p>`;
    expect(extractHtmlDocument(fragment)).toBe(fragment);
    const unclosed = `<!DOCTYPE html><html><body><h1>Ada's Kitchen</h1>`;
    expect(extractHtmlDocument(unclosed)).toBe(unclosed);
  });
});

describe("pruneUnknownPriceRows", () => {
  const facts: CreativeFacts = {
    businessName: "Ada's Kitchen",
    whatItDoes: "Home cooking in Lagos",
    services: ["Jollof rice", "Fried rice", "Chicken", "Small chops"],
    prices: [
      { item: "Jollof rice", price: "₦2,500", listed: true },
      { item: "Fried rice", price: "₦2,500", listed: true },
      { item: "Chicken", price: "₦2,000", listed: true },
      { item: "Small chops", price: "₦1,500", listed: true },
    ],
    contact: "Call 0803 123 4567",
    colours: "",
    notes: "",
  };

  it("drops an invented row and keeps exactly the brief's items", () => {
    const html = `<h1>Ada's Kitchen</h1><table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody><tr><td>Jollof rice</td><td>₦2,500</td></tr><tr><td>Combo deal</td><td>₦5,000</td></tr><tr><td>Chicken</td><td>₦2,000</td></tr></tbody><tfoot><tr><td>Special Offers</td><td>price not listed</td></tr></tfoot></table>`;
    const out = pruneUnknownPriceRows(html, facts);
    expect(out).toContain("Jollof rice");
    expect(out).toContain("Chicken");
    expect(out).not.toContain("Combo deal");
    expect(out).not.toContain("Special Offers");
  });

  it("keeps a facts item with no price — its row still says 'price not listed'", () => {
    const noPriceFacts: CreativeFacts = {
      ...facts,
      prices: [{ item: "Small chops", price: "price not listed", listed: false }],
    };
    const html = `<table><tbody><tr><td>Small chops</td><td>price not listed</td></tr><tr><td>Special Offers</td><td>price not listed</td></tr></tbody></table>`;
    const out = pruneUnknownPriceRows(html, noPriceFacts);
    expect(out).toContain("Small chops");
    expect(out).toContain("price not listed");
    expect(out).not.toContain("Special Offers");
  });

  it("matches case-insensitively with extra whitespace, and keeps header and note rows", () => {
    const html = `<table><thead><tr><th>Item</th><th>Price</th></tr></thead><tbody><tr><td>  JOLLOF RICE </td><td>₦2,500</td></tr><tr><td colspan="2">All prices include tax</td></tr></tbody></table>`;
    const out = pruneUnknownPriceRows(html, facts);
    expect(out).toContain("JOLLOF RICE");
    expect(out).toContain("Item");
    expect(out).toContain("All prices include tax");
  });

  it("leaves the page untouched when the brief lists no prices", () => {
    const html = `<table><tbody><tr><td>Special Offers</td><td>price not listed</td></tr></tbody></table>`;
    expect(pruneUnknownPriceRows(html, { ...facts, prices: [] })).toBe(html);
  });
});

describe("buildImagePrompt", () => {
  it("uses only the brief's facts, and says no text in the picture", () => {
    const facts: CreativeFacts = {
      businessName: "Ada's Kitchen",
      whatItDoes: "Home cooking and catering in Lekki, Lagos",
      services: ["Jollof rice", "Small chops"],
      prices: [{ item: "Jollof rice", price: "₦2,500", listed: true }],
      contact: "WhatsApp 0803 123 4567",
      colours: "",
      notes: "",
    };
    const prompt = buildImagePrompt(facts, "flyers");
    expect(prompt).toContain("Ada's Kitchen");
    expect(prompt).toContain("Jollof rice");
    expect(prompt).toMatch(/no text/i);
    expect(prompt).toMatch(/no words/i);
    // The picture prompt carries no price — a price in the picture
    // would be a lie the customer paid for.
    expect(prompt).not.toContain("₦2,500");
    expect(prompt).not.toContain("0803");
  });
});

describe("insertHeroImage", () => {
  const img = "data:image/jpeg;base64,/9j/FAKE==";
  it("replaces the marker when the model left one", () => {
    const html = `<h1>Ada's Kitchen</h1>${HERO_IMAGE_MARKER}<p>Food.</p>`;
    const out = insertHeroImage(html, img, "Ada's Kitchen");
    expect(out).not.toContain(HERO_IMAGE_MARKER);
    expect(out).toContain(`<img src="${img}"`);
    expect(out.indexOf("</h1>")).toBeLessThan(out.indexOf("<img"));
  });
  it("falls back to right after the headline when there is no marker", () => {
    const html = `<h1>Ada's Kitchen</h1><p>Food.</p>`;
    const out = insertHeroImage(html, img, "Ada's Kitchen");
    expect(out).toContain(`</h1><img src="${img}"`);
  });
  it("leaves the picture out when there is no headline to hang it on", () => {
    const out = insertHeroImage(`<p>Food.</p>`, img, "Ada's Kitchen");
    expect(out).not.toContain("<img");
  });
});

const FAKE_IMG = "data:image/jpeg;base64,/9j/FAKEBASE64==";

function fakeImage(costUsd = 0.009) {
  let calls = 0;
  const image = async (input: { prompt: string }): Promise<ImageResult | null> => {
    calls += 1;
    return { dataUri: FAKE_IMG, costUsd, model: "gpt-image-1.5" };
  };
  return { image, calls: () => calls };
}

describe("runCreative — the picture", () => {
  it("makes one picture for a website, puts it in the page, and records its cost", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": ADA_FACTS,
      "You are Designer, building": (prompt) => {
        const name = businessNameFromPrompt(prompt);
        return `<!DOCTYPE html><html><head><style>body{background:#FBF9F4}</style></head><body><h1>${name}</h1>${HERO_IMAGE_MARKER}<p>Home cooking in Lekki</p></body></html>`;
      },
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nThe website only uses facts from the brief.",
    });
    const { image } = fakeImage();
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.image).toBe(FAKE_IMG);
    expect(result.html).toContain(`<img src="${FAKE_IMG}"`);
    expect(result.html).not.toContain(HERO_IMAGE_MARKER);
    // The picture's cost sits in the money log like any other cost.
    expect(result.steps.some((s) => s.what.includes("Made one picture"))).toBe(true);
    expect(result.steps.find((s) => s.what.includes("Made one picture"))?.costUsd).toBe(0.009);
    expect(result.totalCostUsd).toBeCloseTo(0.013, 6);
    expect(result.totalCostUsd).toBeLessThan(CREATIVE_MODEL_BUDGET_USD);
  });

  it("hangs the picture after the headline when the model left no marker", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": ADA_FACTS,
      "You are Designer, making": () =>
        `<!DOCTYPE html><html><body><h1>Ada's Kitchen</h1><table><tr><td>Jollof rice</td><td>₦2,500</td></tr></table></body></html>`,
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nFine.",
    });
    const { image } = fakeImage();
    const result = await runCreative(
      { brief: "A flyer for Ada's Kitchen — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "flyers" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain(`</h1><img src="${FAKE_IMG}"`);
  });

  it("puts the picture on the first slide of a slideshow", async () => {
    const { chat } = slideshowDeps();
    const { image } = fakeImage();
    const result = await runCreative(
      { brief: "A short promo for Ada's Kitchen in Lekki — jollof rice ₦2,500, small chops, catering. WhatsApp 0803 123 4567.", jobType: "promo-video" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.image).toBe(FAKE_IMG);
    expect(result.slides).toHaveLength(5);
    expect(result.slides[0].image).toBe(FAKE_IMG);
    expect(result.slides.slice(1).every((s) => s.image === undefined)).toBe(true);
  });

  it("still delivers without a picture when the picture service does not answer, and says so", async () => {
    const { chat } = websiteDeps();
    const image = async (): Promise<ImageResult | null> => {
      throw new Error("OpenAI images 500: boom");
    };
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.image).toBeNull();
    expect(result.html).not.toContain("<img");
    expect(result.html).toContain("Ada's Kitchen");
    expect(result.steps.some((s) => s.what.includes("No picture this time"))).toBe(true);
  });

  it("makes the picture once — a revision reuses it", async () => {
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
    const { image, calls } = fakeImage();
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat: countingChat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.revisions).toBe(1);
    expect(calls()).toBe(1);
    expect(result.html).toContain(`<img src="${FAKE_IMG}"`);
  });

  it("never sends the picture's bytes to the Auditor — only a placeholder", async () => {
    const { chat, calls } = websiteDeps();
    const { image } = fakeImage();
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    const auditorPrompt = calls.find((c) => c.prompt.includes("You are Auditor"))?.prompt ?? "";
    expect(auditorPrompt).not.toContain("FAKEBASE64");
    expect(auditorPrompt).toContain("[picture]");
    // The Auditor is told the marker means a picture IS there, so it
    // never flags the placeholder as a missing image.
    expect(auditorPrompt).toContain("it is not a missing image");
  });

  it("the picture lands inside the hero, ahead of the headline, when the marker is first", async () => {
    const { chat } = fakeChat({
      "You are Designer, reading": ADA_FACTS,
      "You are Designer, building": () =>
        `<!DOCTYPE html><html><head><style>.hero img{width:100%;border-radius:16px}</style></head><body><header class="hero">${HERO_IMAGE_MARKER}<h1>Ada's Kitchen</h1><p>Home cooking in Lekki</p></header><section><h2>What we serve</h2><p>Jollof rice — ₦2,500</p></section></body></html>`,
      "You are Analyst": "ALL FACTS CHECK OUT",
      "You are Auditor": "PASS\nFine.",
    });
    const { image } = fakeImage();
    const result = await runCreative(
      { brief: "A one-page website for Ada's Kitchen in Lekki — jollof rice ₦2,500. WhatsApp 0803 123 4567.", jobType: "website" },
      { chat, image },
    );
    expect(result.status).toBe("delivered");
    expect(result.html).toContain(`<header class="hero"><img src="${FAKE_IMG}"`);
    expect(result.html.indexOf("<img")).toBeLessThan(result.html.indexOf("<h1>"));
    expect(result.html).not.toContain(HERO_IMAGE_MARKER);
  });
});
