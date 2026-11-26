const FACTS_SCHEMA={type:'object',additionalProperties:false,properties:{businessName:{type:'string'},whatItDoes:{type:'string'},services:{type:'array',items:{type:'string'}},prices:{type:'array',items:{type:'object',additionalProperties:false,properties:{item:{type:'string'},price:{type:'string'},listed:{type:'boolean'}},required:['item','price','listed']}},contact:{type:'string'},colours:{type:'string'},notes:{type:'string'}},required:['businessName','whatItDoes','services','prices','contact','colours','notes']};
import { FLYER_DESIGN_SCHEMA, parseFlyerDesign, renderFlyerSvg, flyerHtml } from "@ikenga/shared";
import { QUALITY_SCHEMA, QUALITY_INSTRUCTIONS, qualityPassed, qualitySummary, unconfirmedPrices } from "./quality.js";
/**
 * The creative jobs — the website, the flyers, and the promo video.
 *
 * Same team pattern as the market report, same money rules, different
 * hands:
 *   Designer — reads the brief and builds the website or the flyer.
 *   Producer — reads the brief and puts the promo slideshow together.
 *   Analyst  — checks every word, price and phone number against the
 *              brief. A price that was not in the brief must be shown
 *              as "price not listed" — never invented.
 *   Auditor  — reads it on a DIFFERENT model and says pass or fix. If
 *              it says fix, the work is revised once. One revision,
 *              then it ships.
 *   Messenger — packs the finished work and delivers it on the job
 *              page, with its fingerprint (the same one the boss seals
 *              on the escrow before the customer can accept).
 *
 * Money rules (the CFO's rules, not the models'):
 *   - A whole creative job may cost at most $0.50 of model time. A
 *     normal job is a few cents. If the next call would push past the
 *     cap, the job stops and says so instead of overspending.
 *   - The weekly tool budget is 30 USDT and one move may be at most
 *     5 USDT (the vault rules) — a $0.50 cap sits far inside both.
 *   - No model ever touches money: models only write words and pages.
 *     The price, the bond and the accept/reject decision stay with
 *     the CFO.
 *
 * What each job delivers, honestly:
 *   - Website: a real one-page website, written from the brief — the
 *     business's own words, services and contact, in the Ikenga
 *     colours — plus one picture of the business, made from the brief.
 *     Shown on the job page in a locked-down frame, and on its own page.
 *   - Flyers: a real printable flyer / price list, written from the
 *     brief, with a print button — plus the same one picture. Prices
 *     come from the brief or are labelled "price not listed".
 *   - Promo video: a motion slideshow — a sequence of slides with the
 *     business's words and colours, moving on the job page with
 *     play/pause, the picture on the first slide. It is labelled a
 *     slideshow, NOT a video file: no video file is made, and none is
 *     pretended. The slideshow can be downloaded as a standalone file.
 *
 * The picture: one per job, made once at the design stage from the
 * brief's facts only (see images.ts — gpt-image-1.5, about $0.019).
 * It is stored as a data URI inside the deliverable, so the frame
 * stays self-contained. A revision reuses it. When the picture cannot
 * be made, the job still delivers without one and says so plainly —
 * never fail a paid job over a picture.
 *
 * Safety: the website and flyer pages are model-written HTML. Before
 * anything is stored, sanitizeHtml() strips scripts, frames, forms
 * and anything that could run code or phone home. A picture survives
 * only as a data URI we made ourselves — every other <img> is cut.
 * The job page still shows the page inside a sandboxed frame with
 * scripts switched off, so even a page that slipped past the strip
 * cannot run. The slideshow never touches model HTML at all — the
 * slides are plain words, and our own page does the moving.
 *
 * Chunked runs: like the report, the work is split into short stages
 * — read the brief, build it, check it, read it through (and a second
 * read-through if the first one asked for fixes). Each stage is one
 * request, saves its work, and says which stage is next.
 * `runCreativeStage` runs one stage from saved progress;
 * `runCreative` just runs the stages one after another, for the
 * local command line and the tests. A customer's revision re-runs
 * the build and read-through stages, reusing the facts already read
 * out of the brief.
 *
 * The chat calls are injectable, so tests can run the whole flow
 * with fakes and never spend a cent or touch the network.
 */
import {
  OPENAI_MODEL_AUDIT,
  OPENAI_MODEL_WORK,
  promptTokenUpperBound,
  chatOpenAI,
  worstCaseCostUsd,
  type OpenAIReply,
} from "./openai.js";
import {
  OPENAI_IMAGE_PRICE_USD,
  generateImageOpenAI,
  type ImageResult,
} from "./images.js";
import { deliverWork } from "./messenger.js";

export const CREATIVE_MODEL_BUDGET_USD = 0.5;
export const CREATIVE_MAX_REVISIONS = 1;

/** Stage numbers. 0 means finished — the work is delivered or refused. */
export const CREATIVE_STAGE_FACTS = 1;
export const CREATIVE_STAGE_BUILD = 2;
export const CREATIVE_STAGE_CHECK = 3;
export const CREATIVE_STAGE_AUDIT = 4;
export const CREATIVE_STAGE_REAUDIT = 5;

export type CreativeJobType = "website" | "flyers" | "promo-video";

/** Plain-words labels for each stage, for the job page. */
export const CREATIVE_STAGE_LABELS: Record<CreativeJobType, Record<number, string>> = {
  website: {
    [CREATIVE_STAGE_FACTS]: "Designer is reading your brief",
    [CREATIVE_STAGE_BUILD]: "Designer is building your website",
    [CREATIVE_STAGE_CHECK]: "Analyst is checking every word against your brief",
    [CREATIVE_STAGE_AUDIT]: "A different model is reading it before it reaches you",
    [CREATIVE_STAGE_REAUDIT]: "Reading the revised website again",
  },
  flyers: {
    [CREATIVE_STAGE_FACTS]: "Designer is reading your brief",
    [CREATIVE_STAGE_BUILD]: "Designer is making your flyer",
    [CREATIVE_STAGE_CHECK]: "Analyst is checking every price against your brief",
    [CREATIVE_STAGE_AUDIT]: "A different model is reading it before it reaches you",
    [CREATIVE_STAGE_REAUDIT]: "Reading the revised flyer again",
  },
  "promo-video": {
    [CREATIVE_STAGE_FACTS]: "Producer is reading your brief",
    [CREATIVE_STAGE_BUILD]: "Producer is putting your slideshow together",
    [CREATIVE_STAGE_CHECK]: "Analyst is checking every word against your brief",
    [CREATIVE_STAGE_AUDIT]: "A different model is reading it before it reaches you",
    [CREATIVE_STAGE_REAUDIT]: "Reading the revised slideshow again",
  },
};

export function creativeStageLabel(stage: number, jobType: CreativeJobType): string {
  if(stage===6)return "Creating the picture for your work";
  if(stage===7)return "Correcting the issues found in review";
  return CREATIVE_STAGE_LABELS[jobType]?.[stage] ?? "";
}

/** Who builds the work — the name the job page shows. */
export const CREATIVE_BUILDER: Record<CreativeJobType, "Designer" | "Producer"> = {
  website: "Designer",
  flyers: "Designer",
  "promo-video": "Producer",
};

export const CREATIVE_JOB_NOUN: Record<CreativeJobType, "website" | "flyer" | "slideshow"> = {
  website: "website",
  flyers: "flyer",
  "promo-video": "slideshow",
};

/** Facts read out of the brief. Only facts from the brief, never invented. */
export interface CreativeFacts {
  businessName: string;
  whatItDoes: string;
  services: string[];
  prices: { item: string; price: string; listed: boolean }[];
  contact: string;
  colours: string;
  notes: string;
}

export interface CreativeSlide {
  title: string;
  text: string;
  /** The job's one picture, as a data URI — only ever on the first slide. */
  image?: string;
}

export interface CreativeStep {
  agent: "Designer" | "Producer" | "Writer" | "Analyst" | "Auditor" | "Messenger";
  what: string;
  detail: string;
  model?: string;
  tokens?: number;
  costUsd?: number;
}

export interface CreativeResult {
  /** The website / flyer page (sanitised HTML). Empty for a slideshow. */
  html: string;
  /** The promo slideshow. Empty for a website / flyer. */
  slides: CreativeSlide[];
  /** The job's one picture, as a data URI — null when the job has none. */
  image: string | null;
  facts: CreativeFacts | null;
  steps: CreativeStep[];
  totalTokens: number;
  totalCostUsd: number;
  /** "delivered" when the Auditor passed it (after at most one revision). */
  status: "delivered" | "refused";
  /** Plain-words reason when refused (e.g. budget, unreadable brief). */
  reason?: string;
  revisions: number;
}

/**
 * Everything a chunked run has done so far, saved after each stage so
 * the next stage can pick it up — even on another server. `stage` is
 * the next stage to run; 0 means the work is delivered or refused.
 */
export interface CreativeProgress {
  generatorVersion?: 1 | 2;
  auditText?: string;
  designSvg?: string;
  stage: number;
  jobType: CreativeJobType;
  brief: string;
  revisionNote?: string;
  facts: CreativeFacts | null;
  html: string;
  slides: CreativeSlide[];
  /** The job's one picture, as a data URI — null until it is made. */
  image: string | null;
  checkText: string;
  steps: CreativeStep[];
  totalTokens: number;
  totalCostUsd: number;
  revisions: number;
  status: "in-progress" | "delivered" | "refused";
  reason?: string;
  deliveredAt: string;
}

export function emptyCreativeProgress(brief: string, jobType: CreativeJobType, revisionNote?: string): CreativeProgress {
  return {
    stage: CREATIVE_STAGE_FACTS,
    jobType,
    brief: brief.trim(),
    revisionNote,
    facts: null,
    html: "",
    slides: [],
    image: null,
    checkText: "",
    steps: [],
    totalTokens: 0,
    totalCostUsd: 0,
    revisions: 0,
    status: "in-progress",
    deliveredAt: "",
  };
}

/** A revision starts again at the build stage, reusing the facts already read. */
export function creativeRevisionProgress(previous: CreativeProgress, revisionNote: string): CreativeProgress {
  return {
    ...emptyCreativeProgress(previous.brief, previous.jobType, revisionNote),
    generatorVersion: previous.generatorVersion,
    totalCostUsd: previous.generatorVersion === 2 ? previous.totalCostUsd : 0,
    totalTokens: previous.generatorVersion === 2 ? previous.totalTokens : 0,
    steps: previous.generatorVersion === 2 ? [...previous.steps] : [],
    stage: previous.generatorVersion === 2 ? CREATIVE_STAGE_FACTS : CREATIVE_STAGE_BUILD,
    facts: previous.generatorVersion === 2 ? null : previous.facts,
    // The old work stays on the page until the new one is built.
    html: previous.html,
    slides: previous.slides,
    // The picture is made once — a revision reuses it, never re-makes it.
    image: previous.image,
  };
}

export function creativeProgressToResult(p: CreativeProgress): CreativeResult {
  return {
    html: p.status === "delivered" ? p.html : "",
    slides: p.status === "delivered" ? p.slides : [],
    image: p.status === "delivered" ? p.image : null,
    facts: p.facts,
    steps: p.steps,
    totalTokens: p.totalTokens,
    totalCostUsd: p.totalCostUsd,
    status: p.status === "delivered" ? "delivered" : "refused",
    reason: p.reason,
    revisions: p.revisions,
  };
}

export interface RunCreativeDeps {
  chat?: (input: { responseSchema?: { name: string; schema: Record<string, unknown> }; model: string; messages: { role: "system" | "user" | "assistant"; content: string }[]; maxTokens?: number; reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }) => Promise<OpenAIReply>;
  /** One picture for the job (see images.ts). When absent, the live
   * OpenAI Images API is used — but only when OPENAI_API_KEY is set.
   * When it returns null or throws, the job still delivers without a
   * picture and says so plainly — never fail a paid job over a picture. */
  image?: (input: { prompt: string }) => Promise<ImageResult | null>;
  /** Extra instructions from the customer ("ask for one free revision"). */
  revisionNote?: string;
  /** Facts already read (a revision reuses them — no new read). */
  existingFacts?: CreativeFacts | null;
}

export interface RunCreativeInput {
  /** The customer's brief, as typed in the Hire form. */
  brief: string;
  jobType: CreativeJobType;
}

function stripCodeFences(text: string): string {
  return text.replace(/^```[a-z]*\n?/gim, "").replace(/```$/gm, "").trim();
}

/**
 * Keep only the HTML document in a model reply. A model can add
 * words before the page ("Here is your website:") or commentary
 * after it ("In this corrected version: ...") — text after </html>
 * would show up at the bottom of the delivered page, so it goes.
 * When there is no complete document, the text is returned as-is
 * and the caller's length/heading check refuses it as before.
 */
export function extractHtmlDocument(text: string): string {
  const clean = stripCodeFences(text);
  const start = clean.search(/<!doctype html[^>]*>|<html[\s>]/i);
  if (start === -1) return clean;
  const end = clean.toLowerCase().lastIndexOf("</html>");
  if (end === -1) return clean;
  return clean.slice(start, end + "</html>".length);
}

/** Pull the first JSON object out of a model reply (fences or no fences). */
function extractJsonObject(text: string): string | null {
  const clean = stripCodeFences(text);
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return clean.slice(start, end + 1);
}

function factsText(facts: CreativeFacts): string {
  const lines = [
    `Business: ${facts.businessName || "(not named in the brief)"}`,
    `What it does: ${facts.whatItDoes}`,
    `Services / offers: ${facts.services.length > 0 ? facts.services.join("; ") : "(none given)"}`,
    `Prices: ${
      facts.prices.length > 0
        ? facts.prices.map((p) => `${p.item} — ${p.listed ? p.price : "price not listed"}`).join("; ")
        : "(none given)"
    }`,
    `Contact: ${facts.contact || "(none given)"}`,
    `Colours / mood: ${facts.colours || "(none asked for — use the Ikenga colours)"}`,
    `Other notes: ${facts.notes || "(none)"}`,
  ];
  return lines.join("\n");
}

function parseFacts(text: string): CreativeFacts | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<CreativeFacts>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      businessName: typeof raw.businessName === "string" ? raw.businessName.trim() : "",
      whatItDoes: typeof raw.whatItDoes === "string" ? raw.whatItDoes.trim() : "",
      services: Array.isArray(raw.services) ? raw.services.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean) : [],
      prices: Array.isArray(raw.prices)
        ? raw.prices
            .filter((p): p is { item: string; price: string; listed: boolean } => typeof p === "object" && p !== null && typeof (p as { item: unknown }).item === "string")
            .map((p) => ({
              item: String(p.item).trim(),
              price: typeof p.price === "string" ? p.price.trim() : "price not listed",
              listed: p.listed === true,
            }))
            .filter((p) => p.item.length > 0)
        : [],
      contact: typeof raw.contact === "string" ? raw.contact.trim() : "",
      colours: typeof raw.colours === "string" ? raw.colours.trim() : "",
      notes: typeof raw.notes === "string" ? raw.notes.trim() : "",
    };
  } catch {
    return null;
  }
}

/**
 * The picture prompt — built from the brief's facts only, never
 * invented. One line, so it can travel as a single command argument.
 * It says "no text" because image models render garbled words, and a
 * picture with a wrong price or a made-up sign would be a lie the
 * customer paid for.
 */
export function buildImagePrompt(facts: CreativeFacts, jobType: CreativeJobType): string {
  const subject = [
    facts.businessName,
    facts.whatItDoes,
    facts.services.slice(0, 3).join(", "),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" — ");
  const kind = jobType === "promo-video" ? "a short promo" : jobType === "flyers" ? "a flyer" : "a website";
  return `A bright, realistic photograph for ${subject || "a small business in Nigeria"}, for ${kind}. Show the food or the work itself, warm daylight, a clean simple scene. No text, no words, no letters, no numbers, no signs, no logos, no prices in the picture — the picture must carry no writing at all. Only what the brief describes — do not add any product, dish or object the brief does not mention.`;
}

/** Where the picture goes in a website / flyer page: a marker the model puts after the headline. */
export const HERO_IMAGE_MARKER = "<!-- HERO_IMAGE -->";

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Put the job's picture into a built page: at the marker when the
 * model left one, otherwise right after the main headline. When
 * there is no headline to hang it on, the picture stays out — a
 * picture floating above nothing would look worse than none.
 */
export function insertHeroImage(html: string, dataUri: string, alt: string): string {
  const img = `<img src="${dataUri}" alt="${escapeAttr(alt)}">`;
  if (html.includes(HERO_IMAGE_MARKER)) return html.replace(HERO_IMAGE_MARKER, img);
  const h1 = html.match(/<\/h1\s*>/i);
  if (h1 && h1.index !== undefined) {
    const at = h1.index + h1[0].length;
    return `${html.slice(0, at)}${img}${html.slice(at)}`;
  }
  return html;
}

/**
 * Drop price-table rows whose item is not in the brief's facts.
 *
 * A model can slip an extra row into a flyer's price list — "Special
 * Offers", "Combo deal" — even when the prompt says not to. This is
 * the deterministic backstop: a row stays only when its first cell
 * names an item from the facts (case-insensitive, trimmed; a
 * parenthetical qualifier after the name, like "Jollof rice (spicy)",
 * still counts as the same item). Header rows and single-cell note
 * rows name no item, so they stay. A row for a facts item with no
 * price stays too — it still says "price not listed".
 *
 * When the brief lists no prices at all there is nothing to match
 * against, so the page is returned untouched — dropping every row
 * would be worse than the slip it guards against.
 */
export function pruneUnknownPriceRows(html: string, facts: CreativeFacts): string {
  const known = facts.prices.map((p) => normalizeItemName(p.item)).filter(Boolean);
  if (known.length === 0) return html;
  return html.replace(/<table[\s\S]*?<\/table\s*>/gi, (table) =>
    table.replace(/<tr\b[^>]*>[\s\S]*?<\/tr\s*>/gi, (row) => {
      if (/<th\b/i.test(row)) return row;
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)];
      if (cells.length < 2) return row;
      const item = normalizeItemName(cells[0][1]);
      const isKnown = known.some((k) => item === k || item.startsWith(`${k} (`));
      return isKnown ? row : "";
    }),
  );
}

function normalizeItemName(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[:.\-–—]+$/, "")
    .trim();
}

function parseSlides(text: string): CreativeSlide[] | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as { slides?: unknown };
    if (!Array.isArray(raw.slides)) return null;
    const slides = raw.slides
      .filter((s): s is { title: string; text: string } => typeof s === "object" && s !== null && typeof (s as { title: unknown }).title === "string" && typeof (s as { text: unknown }).text === "string")
      .map((s) => ({ title: s.title.trim(), text: s.text.trim() }))
      .filter((s) => s.title.length > 0 && s.text.length > 0);
    return slides.length >= 3 ? slides : null;
  } catch {
    return null;
  }
}

/**
 * Strip anything that could run code or reach out from model-written
 * HTML, before it is stored or shown. Scripts, frames, forms and
 * plug-ins go entirely; event-handler attributes and javascript:
 * links are cut. Pictures are the one exception: an <img> survives
 * only when its source is a data URI we made ourselves (the job's
 * own picture, embedded as base64) — every other picture, external
 * or javascript:, is stripped. Inline <style> stays — it is what
 * makes the page look finished — but it cannot run code. The page is
 * still shown in a sandboxed frame with scripts switched off.
 */
export function responsiveDocument(html: string): string {
  return html.replace(/<head[^>]*>/i, head => head + '<meta name="viewport" content="width=device-width, initial-scale=1">');
}

export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  // A <title> is stripped with its text: leaving the text behind
  // would print the name twice — once small at the top of the page
  // (stray text in <head> is rendered by the browser) and once as
  // the headline.
  out = out.replace(/<title[\s\S]*?<\/title\s*>/gi, "");
  out = out.replace(/<style[\s\S]*?url\(\s*javascript:[^)]*\)[\s\S]*?<\/style\s*>/gi, "");
  out = out.replace(/<\/?(iframe|object|embed|form|link|meta|base|title|noscript|template|slot|audio|video|input|button|select|textarea)\b[^>]*>/gi, "");
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  out = out.replace(/(href|src|action)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '$1="#"');
  out = out.replace(/url\(\s*javascript:[^)]*\)/gi, "url(#)");
  // Pictures: keep only our own embedded ones. Anything else — an
  // external URL, a javascript: source, a source with no value — goes.
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i);
    if (!srcMatch) return "";
    const src = srcMatch[1].replace(/^["']|["']$/g, "");
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) return "";
    const altMatch = tag.match(/\salt\s*=\s*("[^"]*"|'[^']*')/i);
    const alt = altMatch ? ` alt=${altMatch[1].replace(/"/g, "&quot;")}` : ` alt=""`;
    return `<img src="${src}"${alt}>`;
  });
  return out.trim();
}

function buildPrompt(jobType: CreativeJobType, facts: CreativeFacts, revisionNote?: string, upgraded = false): string {
  const palette = upgraded ? "Use the customer’s colours when specified. Otherwise choose a restrained palette suited to this business and audience; do not copy the Ikenga app branding into every customer design. Set a consistent type scale, readable contrast and clear spacing." :
    "Use the Ikenga colours unless the brief asked for others: cream #FBF9F4 background, deep green #13271C for headings, leaf green #A3E36A for buttons and highlights, brass #C8902F for small accents.";
  const rules = `Rules: every word on the page must come from the facts below or the brief — do not invent a service, a price, a phone number, an address or a claim. List only what is in the facts — never add an extra row, offer, section, slide or item that is not in the facts (no "Special Offers", no "Combo deal", no extras of any kind). If a price was not in the brief, write "price not listed" — never guess a price. Write in plain, warm, human words — no jargon. No JavaScript, no forms. Pictures are made for you and put in the page — never link a picture from anywhere else, and never write an <img> tag yourself. Style it fully with inline <style> so it looks finished on its own.`;
  const briefFacts = factsText(facts);
  if (jobType === "website") {
    return `You are Designer, building a one-page website for a small business in Nigeria.\n\nThe facts (only use these — do not invent anything):\n${briefFacts}\n${revisionNote ? `\nThe customer asked for a change: ${revisionNote}\n` : ""}\nBuild the whole website and return ONLY the HTML for one complete page (<!DOCTYPE html> to </html>). Lay it out like a real small-business website, in this order:\n\n1. A hero at the top: <header class="hero"> — the business name big first, then put ${HERO_IMAGE_MARKER} on its own line (the picture goes there), then one plain line about what it does, and a big call/order button (a link to the phone or WhatsApp from the facts).\n2. What they serve: one card per service from the facts — each card shows the service name and its price (write "price not listed" where the brief gave no price). Only the services in the facts — no extras, no invented sections.\n3. Hours and place: opening hours and location in their own section, only if the facts give them.\n4. Call and order: the contact big, with the same big call/order button.\n\n${palette} The hero picture must look right when it lands: write CSS for .hero img (full width, rounded corners). One column, max-width about 720px, readable on a phone, and it must print cleanly on plain white paper (light background, dark text).\n\n${rules}`;
  }
  if (jobType === "flyers") {
    return `You are Designer, making a printable flyer and price list for a small business in Nigeria.\n\nThe facts (only use these — do not invent anything):\n${briefFacts}\n${revisionNote ? `\nThe customer asked for a change: ${revisionNote}\n` : ""}\nBuild the flyer and return ONLY the HTML for one complete page (<!DOCTYPE html> to </html>). It must have: a big headline with the business name, what it does in one plain line, a price list (a table: item, price — list exactly the items in the facts, in the same order, and nothing else, and write "price not listed" where the brief gave no price), and the contact big at the bottom so a customer can order from it. Put ${HERO_IMAGE_MARKER} on its own line right after the headline — the picture goes there. Make it fit on one printed A4 page (about 794px wide). ${palette}\n\n${rules}`;
  }
  return `You are Producer, putting together a motion slideshow for a small business in Nigeria — the words and pictures of a short promo, as moving slides.\n\nThe facts (only use these — do not invent anything):\n${briefFacts}\n${revisionNote ? `\nThe customer asked for a change: ${revisionNote}\n` : ""}\nReturn JSON ONLY, in this shape: {"slides": [{"title": "...", "text": "..."}]}. Five slides: 1) the hook — the one line that makes someone stop; 2) what the business does; 3) the offer or services; 4) the prices (write "price not listed" where the brief gave no price); 5) how to order — the contact from the facts. Each slide: a title under 8 words, text under 25 words. Every word must come from the facts or the brief — do not invent a service, a price, a phone number or a claim. List only what is in the facts — never add an extra row, offer, section, slide or item that is not in the facts. Write in plain, warm, human words.`;
}

function auditPrompt(jobType: CreativeJobType, facts: CreativeFacts, deliverable: string, checkText: string): string {
  const noun = CREATIVE_JOB_NOUN[jobType];
  return `You are Auditor, reading a ${noun} before it reaches the customer. You are a different model from the one that built it.\n\nThe ${noun}:\n${deliverable}\n\nA "[picture]" marker in the work means the job's own picture is embedded there — it is not a missing image, so never flag it as one.\n\nThe numbers check:\n${checkText}\n\nThe facts from the brief (the only facts allowed):\n${factsText(facts)}\n\nAnswer with exactly one line first: PASS or FIX. Then, if FIX, say in plain words what is wrong and what must change. Only judge it against the facts — a word that is in the facts is fine, a word that is not is a problem. A price shown as "price not listed" is fine; a price that is not in the facts is a problem.`;
}

/**
 * Run ONE stage of a creative job from saved progress, and return the
 * updated progress (saved by the caller after each stage). A stage is
 * short — at most two model calls — so it fits in a 60s request.
 */
export async function runCreativeStage(progress: CreativeProgress, deps: RunCreativeDeps = {}): Promise<CreativeProgress> {
  const brief = progress.brief.trim();
  const jobType = progress.jobType;
  const builder = CREATIVE_BUILDER[jobType];
  const noun = CREATIVE_JOB_NOUN[jobType];
  const p: CreativeProgress = {
    ...progress,
    steps: [...progress.steps],
    slides: [...progress.slides],
  };
  if (!brief) {
    return { ...p, stage: 0, status: "refused", reason: "There was no brief to work from." };
  }
  if (p.status !== "in-progress" || p.stage === 0) return p;

  const upgraded = p.generatorVersion === 2;
  const rawChat = deps.chat ?? (async (c) => chatOpenAI(c));
  const chat = rawChat;

  const charge = (reply: OpenAIReply, agent: CreativeStep["agent"], what: string) => {
    p.totalTokens += reply.usage.totalTokens;
    p.totalCostUsd = Math.round((p.totalCostUsd + reply.costUsd) * 1_000_000) / 1_000_000;
    p.steps.push({ agent, what, detail: "", model: reply.model, tokens: reply.usage.totalTokens, costUsd: reply.costUsd });
  };

  /** Refuse instead of overspending: check the worst case before each call. */
  const withinBudget = (model: string, prompt: string, maxTokens: number): boolean =>
    p.totalCostUsd + worstCaseCostUsd(model, promptTokenUpperBound(prompt), maxTokens) <= CREATIVE_MODEL_BUDGET_USD;

  /** Already spent too much (a call cost more than its worst case) — stop now. */
  const overBudget = (): boolean => p.totalCostUsd > CREATIVE_MODEL_BUDGET_USD;

  const refuse = (reason: string): CreativeProgress => ({
    ...p, html: "", slides: [], stage: 0, status: "refused", reason, deliveredAt: new Date().toISOString(),
  });
  const deliver = (): CreativeProgress => {
    // Messenger packs the finished work and delivers it on the job
    // page — its fingerprint is the same one the boss seals on the
    // escrow before the customer can accept.
    const content = jobType === "promo-video" ? { slides: p.slides } : { html: p.html };
    p.steps.push(deliverWork(content, noun).step);
    return { ...p, stage: 0, status: "delivered", deliveredAt: new Date().toISOString() };
  };

  // --- Stage 1: read the brief and pull out the facts. ---
  if (p.stage === CREATIVE_STAGE_FACTS) {
    if (p.facts) {
      // A revision reuses the facts already read — no new read.
      p.steps.push({
        agent: builder,
        what: `Read the brief again — ${p.facts.businessName ? `"${p.facts.businessName}"` : "the business"}: ${p.facts.whatItDoes || "what it does, its services and its contact"}.`,
        detail: factsText(p.facts).slice(0, 400),
      });
      return { ...p, stage: upgraded ? 6 : CREATIVE_STAGE_BUILD };
    }
    const factsPrompt = `You are ${builder}, reading a customer's brief for a ${noun} for a small business in Nigeria.\n\nThe brief:\n${brief}\n${p.revisionNote ? "Customer corrections (override earlier facts): " + p.revisionNote : ""}\n\nReply with JSON ONLY, in this shape: {"businessName": "...", "whatItDoes": "...", "services": ["..."], "prices": [{"item": "...", "price": "...", "listed": true}], "contact": "...", "colours": "...", "notes": "..."}.\n\nRules: only use facts from the brief. If the brief does not name the business, leave businessName empty. If a price is not in the brief, do not list it as a price — either leave it out of prices or list it with listed: false and price: "price not listed". Never invent a business name, a price, a phone number, an address or a service. If the brief has no usable facts at all, reply with {"businessName": "", "whatItDoes": "", "services": [], "prices": [], "contact": "", "colours": "", "notes": "no usable facts in the brief"}.`;
    if (!withinBudget(OPENAI_MODEL_WORK, factsPrompt, 1200)) {
      return refuse(`The ${noun} would cost more than the $0.50 set aside for it, so it stopped before spending anything.`);
    }
    const read = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: factsPrompt }], ...(upgraded?{responseSchema:{name:"creative_facts",schema:FACTS_SCHEMA}}:{}), maxTokens: 1200, reasoningEffort: "low" });
    charge(read, builder, `Read the brief.`);
    if (overBudget()) return refuse(`The ${noun} already cost more than the $0.50 set aside for it, so it stopped instead of spending more.`);
    let facts = parseFacts(read.text);
    if (!facts) {
      if(upgraded)return refuse("The confirmed business facts could not be read clearly. Please check the brief.");
      if (!withinBudget(OPENAI_MODEL_WORK, factsPrompt + " Reply with JSON only.", 1200)) return refuse("Reading the brief again would exceed the job budget.");
      // One retry: the model may have answered in words instead of JSON.
      const retry = await chat({
        model: OPENAI_MODEL_WORK,
        messages: [{ role: "user", content: `${factsPrompt}\n\nReply with JSON only — no words before or after it.` }],
        maxTokens: 1200,
        reasoningEffort: "low",
      });
      charge(retry, builder, `Read the brief again — the first answer was not in a readable shape.`);
      if (overBudget()) return refuse(`The ${noun} already cost more than the $0.50 set aside for it, so it stopped instead of spending more.`);
      facts = parseFacts(retry.text);
    }
    if (!facts) {
      return refuse("The brief could not be read clearly — try a shorter brief with the business name, what it does, and how to reach it.");
    }
    p.facts = facts;
    // The read step(s) above carry the cost; fill in what was read.
    p.steps[p.steps.length - 1].what = `Read the brief — ${facts.businessName ? `"${facts.businessName}"` : "the business"}: ${facts.whatItDoes || "what it does, its services and its contact"}.`;
    p.steps[p.steps.length - 1].detail = factsText(facts).slice(0, 400);
    if (facts.businessName === "" && facts.whatItDoes === "" && facts.services.length === 0) {
      return refuse("The brief did not say what the business is or what it does — try again with the business name, what it does, and how to reach it.");
    }
    return { ...p, stage: CREATIVE_STAGE_BUILD };
  }

  if (!p.facts) {
    return refuse("The brief was not read yet — start the job again.");
  }
  const facts = p.facts;
  /**
   * The work as the Analyst and Auditor see it. The picture is a
   * long base64 string — they only need to know a picture is there,
   * not its bytes, so it is replaced with a placeholder. Sending the
   * bytes would burn the budget on tokens and tell them nothing.
   */
  const deliverableText = (): string => {
    if (jobType === "promo-video") {
      const slides = p.slides.map((s) => ({ title: s.title, text: s.text, ...(s.image ? { image: "[picture]" } : {}) }));
      return JSON.stringify({ slides }, null, 2);
    }
    return p.html.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,"[picture]").replace(/<img\b[^>]*>/gi, "<img [picture]>");
  };
  /** The picture, once made, belongs in the finished work — on the
   * first slide for a slideshow, after the headline for a page. */
  const attachImage = (): void => {
    if (!p.image || upgraded && jobType === "flyers") return;
    if (jobType === "promo-video") {
      if (p.slides.length > 0) {
        p.slides = [{ ...p.slides[0], image: p.image }, ...p.slides.slice(1)];
      }
      return;
    }
    const alt = [facts.businessName, facts.whatItDoes].map((s) => s.trim()).filter(Boolean).join(" — ") || "The business";
    p.html = insertHeroImage(p.html, p.image, alt);
  };

  if(upgraded && p.stage===6){
    const prompt=buildPrompt(jobType,facts,p.revisionNote,true);
    const maxTokens=jobType==='promo-video'?1200:4000;
    if (!p.image) {
      const imageFn =
        deps.image ??
        (process.env.OPENAI_API_KEY ? async (input: { prompt: string }) => generateImageOpenAI(input) : undefined);
      if (imageFn) {
        if (p.totalCostUsd + OPENAI_IMAGE_PRICE_USD + worstCaseCostUsd(OPENAI_MODEL_WORK, promptTokenUpperBound(prompt), maxTokens) > CREATIVE_MODEL_BUDGET_USD) {
          p.steps.push({ agent: builder, what: "No picture this time — it would not fit in the $0.50 set aside for this job.", detail: "The work is delivered without a picture; nothing else changed." });
        } else {
          try {
            const made = await imageFn({ prompt: buildImagePrompt(facts, jobType) });
            if (made && made.dataUri) {
              p.image = made.dataUri;
              p.totalCostUsd = Math.round((p.totalCostUsd + made.costUsd) * 1_000_000) / 1_000_000;
              p.steps.push({ agent: builder, what: "Made one picture for the work.", detail: `A picture of ${facts.businessName || "the business"} — ${made.model}, about ${made.costUsd.toFixed(3)}.`, model: made.model, costUsd: made.costUsd });
            } else {
              p.steps.push({ agent: builder, what: "No picture this time — the picture did not come back.", detail: "The work is delivered without a picture; nothing else changed." });
            }
          } catch {
            p.steps.push({ agent: builder, what: "No picture this time — the picture service did not answer.", detail: "The work is delivered without a picture; nothing else changed." });
          }
        }
      }
    }

    return {...p,stage:CREATIVE_STAGE_BUILD};
  }
  // --- Stage 2: build the work from the facts. ---
  if (p.stage === CREATIVE_STAGE_BUILD) {
    let prompt = buildPrompt(jobType, facts, p.revisionNote, upgraded) + (upgraded ? "\nDesign direction: respect the customer brand and audience. Use a deliberate visual hierarchy, generous spacing, readable contrast, and a strong contact ending. Avoid an identical generic design for every business. Use responsive CSS with no horizontal overflow at 360px. For flyers, include print-safe spacing and a fluid on-screen preview. For a slideshow, create a concise hook and coherent story; do not call it a rendered video. Creative wording is allowed; invented factual claims such as best or famous are not. Full original brief:\n" + brief : "");
    if(upgraded) prompt = prompt.replaceAll("every word on the page must come from the facts below or the brief", "all factual statements must be supported by the confirmed facts or brief").replaceAll("Every word must come from the facts or the brief", "Every factual statement must be supported by the facts or brief").replace("One column, max-width about 720px", "A thoughtful responsive layout: a spacious hero and service grid on desktop, a single-column flow on phones, max-width about 1100px");
    if(upgraded && jobType === "flyers")prompt=flyerPrompt(facts,brief,p.revisionNote);
    const maxTokens = jobType === "promo-video" ? 1200 : 4000;
    // --- The picture: one per job, made once at the design stage.
    // A revision reuses the picture already made (p.image is set).
    // When the picture cannot be made — the service did not answer,
    // or it would not fit in the $0.50 — the job still delivers
    // without one and says so plainly. When there is no way to call
    // the service at all (no key, no injected stand-in), it is
    // skipped quietly: the live run gate already stops a job without
    // a key, so this only happens in tests and local runs.
    if (!p.image && !upgraded) {
      const imageFn =
        deps.image ??
        (process.env.OPENAI_API_KEY ? async (input: { prompt: string }) => generateImageOpenAI(input) : undefined);
      if (imageFn) {
        if (p.totalCostUsd + OPENAI_IMAGE_PRICE_USD + worstCaseCostUsd(OPENAI_MODEL_WORK, promptTokenUpperBound(prompt), maxTokens) > CREATIVE_MODEL_BUDGET_USD) {
          p.steps.push({ agent: builder, what: "No picture this time — it would not fit in the $0.50 set aside for this job.", detail: "The work is delivered without a picture; nothing else changed." });
        } else {
          try {
            const made = await imageFn({ prompt: buildImagePrompt(facts, jobType) });
            if (made && made.dataUri) {
              p.image = made.dataUri;
              p.totalCostUsd = Math.round((p.totalCostUsd + made.costUsd) * 1_000_000) / 1_000_000;
              p.steps.push({ agent: builder, what: "Made one picture for the work.", detail: `A picture of ${facts.businessName || "the business"} — ${made.model}, about $${made.costUsd.toFixed(3)}.`, model: made.model, costUsd: made.costUsd });
            } else {
              p.steps.push({ agent: builder, what: "No picture this time — the picture did not come back.", detail: "The work is delivered without a picture; nothing else changed." });
            }
          } catch {
            p.steps.push({ agent: builder, what: "No picture this time — the picture service did not answer.", detail: "The work is delivered without a picture; nothing else changed." });
          }
        }
      }
    }
    if (!withinBudget(OPENAI_MODEL_WORK, prompt, maxTokens)) {
      return refuse(`The ${noun} would cost more than the $0.50 set aside for it, so it stopped before spending anything.`);
    }
    const flyer = upgraded && jobType === "flyers";
    const built = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: prompt }], ...(flyer ? {responseSchema:{name:"flyer_design",schema:FLYER_DESIGN_SCHEMA}} : {}), maxTokens });
    charge(built, builder, jobType === "promo-video" ? "Put the slideshow together from the brief." : `Built the ${noun} from the brief.`);
    if (overBudget()) return refuse(`The ${noun} already cost more than the $0.50 set aside for it, so it stopped instead of spending more.`);
    if(flyer){
      const design=parseFlyerDesign(built.text);
      if(!design)return refuse("The flyer design was incomplete.");
      try {p.designSvg=renderFlyerSvg(facts,design,p.image);p.html=flyerHtml(p.designSvg);}catch(error){return refuse(error instanceof Error?error.message:"The flyer text could not fit.");}
      p.slides=[];p.steps[p.steps.length-1].detail="Created a self-contained print design with a checked text layout.";
    } else if (jobType === "promo-video") {
      const slides = parseSlides(built.text);
      if (!slides) {
        return refuse("The slideshow did not come back in a readable shape — try the job again.");
      }
      p.slides = slides;
      p.html = "";
      p.steps[p.steps.length - 1].detail = `${slides.length} slides: ${slides.map((s) => s.title).join(" · ")}`.slice(0, 400);
    } else {
      // The flyer's price list is pruned to the brief's items: a model
      // slip that adds an extra row ("Special Offers") is caught here,
      // deterministically, even if the prompt and the Auditor miss it.
      const rawHtml = sanitizeHtml(extractHtmlDocument(built.text));
      const html = jobType === "flyers" ? pruneUnknownPriceRows(rawHtml, facts) : rawHtml;
      if (html.length < 120 || !/<(h1|h2)[\s>]/.test(html)) {
        return refuse(`The ${noun} did not come back as a finished page — try the job again.`);
      }
      p.html = upgraded ? responsiveDocument(html) : html;
      p.slides = [];
      p.steps[p.steps.length - 1].detail = `About ${html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length} words, built from your brief.`;
    }
    attachImage();
    return { ...p, stage: CREATIVE_STAGE_CHECK };
  }

  // --- Stage 3, Analyst: check every word, price and number against the facts. ---
  if (p.stage === CREATIVE_STAGE_CHECK) {
    let checkPrompt = `You are Analyst, checking a ${noun} against the brief it was built from.\n\nThe ${noun}:\n${deliverableText()}\n\nThe facts from the brief (the only facts allowed):\n${factsText(facts)}\n\nList every business name, service, price, phone number and address in the ${noun}, and for each one say whether it is in the facts or not. End with one line: either "ALL FACTS CHECK OUT" or "PROBLEMS:" followed by the list of words that could not be checked. Do not add new facts. A price shown as "price not listed" is fine.`;
    if (upgraded) checkPrompt += "\n" + QUALITY_INSTRUCTIONS + "\nOriginal brief: " + brief + "\nCustomer corrections: " + (p.revisionNote ?? "none");
    if (!withinBudget(OPENAI_MODEL_WORK, checkPrompt, 2000)) {
      return refuse(`The ${noun} would cost more than the $0.50 set aside for it, so it stopped before spending anything.`);
    }
    const check = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: checkPrompt }], ...(upgraded ? { responseSchema: { name: "quality", schema: QUALITY_SCHEMA } } : {}), maxTokens: 2000, reasoningEffort: "low" });
    charge(check, "Analyst", `Checked every word, price and phone number against the brief.`);
    if (overBudget()) return refuse(`The ${noun} already cost more than the $0.50 set aside for it, so it stopped instead of spending more.`);
    p.checkText = stripCodeFences(check.text);
    p.steps[p.steps.length - 1].detail = upgraded ? qualitySummary(p.checkText) : p.checkText.slice(-300);
    return { ...p, stage: upgraded && p.revisions > 0 ? CREATIVE_STAGE_REAUDIT : CREATIVE_STAGE_AUDIT };
  }

  function flyerPrompt(facts:CreativeFacts,original:string,note?:string):string {
    return 'You are Designer, making a refined flyer. Return JSON only: {"headline":"short offer headline","subheading":"one useful line about the business","details":"opening hours and location if supplied","accent":"#RRGGBB","background":"#RRGGBB"}. Business name, services, prices and contact are placed exactly from confirmed facts by the renderer. Do not repeat the price list in the headline or subheading. Use the customer’s colours; choose a dark accent readable behind white text and a light background. No invented claims or missing requested facts. Facts: '+factsText(facts)+'\nOriginal brief: '+original+'\nCorrections: '+(note??'none');
  }
  async function revise(auditText:string):Promise<CreativeProgress>{
    const priceIssues=upgraded?unconfirmedPrices(deliverableText(),brief+'\n'+(p.revisionNote??'')):[];
    let fixPrompt =
      jobType === "promo-video"
        ? `You are Producer. The Auditor read your slideshow and asked for fixes. Fix exactly what it flagged, and nothing else.\n\nThe Auditor's notes:\n${auditText}\nAnalyst checks: ${p.checkText}\nDeterministic checks: ${priceIssues.join("; ")}\n\nThe slideshow:\n${deliverableText()}\n\nThe facts (only use facts from here):\n${factsText(facts)}\n\nReturn JSON ONLY, same shape as before: {"slides": [{"title": "...", "text": "..."}]}. Do not invent any fact.`
        : `You are ${builder}. The Auditor read your ${noun} and asked for fixes. Fix exactly what it flagged, and nothing else.\n\nThe Auditor's notes:\n${auditText}\nAnalyst checks: ${p.checkText}\nDeterministic checks: ${priceIssues.join("; ")}\n\nThe ${noun}:\n${deliverableText()}\n\nThe facts (only use facts from here):\n${factsText(facts)}\n\nReturn the full corrected ${noun} as HTML, same shape as before. Do not invent any fact. No JavaScript, no external pictures, no forms.`;
    const flyer=upgraded && jobType==="flyers";
    if(flyer)fixPrompt=flyerPrompt(facts,brief,p.revisionNote)+"\nQuality corrections: "+auditText+"\nAnalyst: "+p.checkText;
    const fixMaxTokens = jobType === "promo-video" ? 1200 : 4000;
    if (!withinBudget(OPENAI_MODEL_WORK, fixPrompt, fixMaxTokens)) {
      return refuse(`The ${noun} would cost more than the $0.50 set aside for it, so it stopped before spending anything.`);
    }
    const fixed = await chat({ model: OPENAI_MODEL_WORK, messages: [{ role: "user", content: fixPrompt }], ...(flyer?{responseSchema:{name:"flyer_design",schema:FLYER_DESIGN_SCHEMA}}:{}), maxTokens: fixMaxTokens });
    charge(fixed, builder, `Revised the ${noun} once, fixing what the Auditor flagged.`);
    if (overBudget()) return refuse(`The ${noun} already cost more than the $0.50 set aside for it, so it stopped instead of spending more.`);
    if(flyer){
      const design=parseFlyerDesign(fixed.text);if(!design)return refuse("The revised flyer was incomplete.");
      try{p.designSvg=renderFlyerSvg(facts,design,p.image);p.html=flyerHtml(p.designSvg);}catch(error){return refuse(error instanceof Error?error.message:"The flyer text could not fit.");}
    } else if (jobType === "promo-video") {
      const slides = parseSlides(fixed.text);
      if (!slides) return refuse("The revised slideshow did not come back in a readable shape — try the job again.");
      p.slides = slides;
      p.steps[p.steps.length - 1].detail = `${slides.length} slides, revised.`;
    } else {
      const rawHtml = sanitizeHtml(extractHtmlDocument(fixed.text));
      const html = jobType === "flyers" ? pruneUnknownPriceRows(rawHtml, facts) : rawHtml;
      if (html.length < 120 || !/<(h1|h2)[\s>]/.test(html)) return refuse(`The revised ${noun} did not come back as a finished page — try the job again.`);
      p.html = html;
      p.steps[p.steps.length - 1].detail = "Revised once.";
    }
    // The revised work gets the same picture back — it was made once.
    attachImage();
    p.revisions += 1;
    return { ...p, stage: upgraded ? CREATIVE_STAGE_CHECK : CREATIVE_STAGE_REAUDIT };
  }
  if(upgraded && p.stage===7)return revise(p.auditText??'The previous quality check was incomplete.');

  // --- Stages 4 and 5, Auditor: a different model reads it and says pass or fix. ---
  if (p.stage === CREATIVE_STAGE_AUDIT || p.stage === CREATIVE_STAGE_REAUDIT) {
    const isReaudit = p.stage === CREATIVE_STAGE_REAUDIT;
    const prompt = auditPrompt(jobType, facts, deliverableText(), p.checkText) + (upgraded ? "\nOverride the one-line verdict instruction above. " + QUALITY_INSTRUCTIONS + "\nOriginal brief: " + brief + "\nCustomer corrections: " + (p.revisionNote ?? "none") : "");
    if (!withinBudget(OPENAI_MODEL_AUDIT, prompt, 1500)) {
      return refuse(`The ${noun} would cost more than the $0.50 set aside for it, so it stopped before spending anything.`);
    }
    const audit = await chat({ model: OPENAI_MODEL_AUDIT, messages: [{ role: "user", content: prompt }], ...(upgraded ? { responseSchema: { name: "quality", schema: QUALITY_SCHEMA } } : {}), maxTokens: 1500, reasoningEffort: "low" });
    charge(audit, "Auditor", isReaudit ? `Read the revised ${noun} again.` : `Read the ${noun} on a different model, before it reaches you.`);
    if (overBudget()) return refuse(`The ${noun} already cost more than the $0.50 set aside for it, so it stopped instead of spending more.`);
    const auditText = stripCodeFences(audit.text);
    p.steps[p.steps.length - 1].detail = upgraded ? qualitySummary(auditText) : auditText.slice(0, 400);
    const verdict = auditText.replace(/^[^A-Za-z]+/, "");
    const priceIssues = upgraded ? unconfirmedPrices(deliverableText(), brief + "\n" + (p.revisionNote ?? "")) : [];
    if (upgraded ? qualityPassed(auditText) && qualityPassed(p.checkText) && priceIssues.length === 0 : /^PASS\b/i.test(verdict)) {
      return deliver();
    }
    if (isReaudit && upgraded) return refuse("The work did not pass its factual and completeness checks after revision. " + [...priceIssues, qualitySummary(auditText), qualitySummary(p.checkText)].join(" ").slice(0, 600));
    if (isReaudit) {
      // One revision was already used. Ship it, but say so plainly.
      p.steps.push({ agent: "Auditor", what: `Still had notes after one revision — the ${noun} is shown with them.`, detail: auditText.slice(0, 400) });
      return deliver();
    }
    // One free revision: rebuild it, fixing what the Auditor flagged.
    return upgraded ? {...p,stage:7,auditText} : revise(auditText);
  }

  return p;
}

/** Run the whole creative job, one stage at a time (the local command line and the tests). */
export async function runCreative(input: RunCreativeInput, deps: RunCreativeDeps = {}): Promise<CreativeResult> {
  const brief = input.brief.trim();
  if (!brief) {
    return { html: "", slides: [], image: null, facts: null, steps: [], totalTokens: 0, totalCostUsd: 0, status: "refused", reason: "There was no brief to work from.", revisions: 0 };
  }
  let progress = emptyCreativeProgress(brief, input.jobType, deps.revisionNote);
  if (deps.existingFacts) {
    // A revision reuses the facts already read — no new read, but the
    // read step still shows what was read.
    progress.facts = deps.existingFacts;
    progress.steps.push({
      agent: CREATIVE_BUILDER[input.jobType],
      what: `Read the brief again — ${deps.existingFacts.businessName ? `"${deps.existingFacts.businessName}"` : "the business"}: ${deps.existingFacts.whatItDoes || "what it does, its services and its contact"}.`,
      detail: factsText(deps.existingFacts).slice(0, 400),
    });
    progress.stage = CREATIVE_STAGE_BUILD;
  }
  while (progress.status === "in-progress" && progress.stage !== 0) {
    progress = await runCreativeStage(progress, deps);
  }
  return creativeProgressToResult(progress);
}
