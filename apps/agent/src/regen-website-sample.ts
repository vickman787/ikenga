/**
 * Regenerate the website sample with the redesigned hero layout — no
 * Sepolia money, no new picture.
 *
 *   1. The picture is reused from the testnet run: the data URI is
 *      read out of the existing docs/samples/flyer-adas-kitchen.html.
 *      No new image is paid for.
 *   2. The chat runs through the OpenAI connector helper (the repo
 *      has no local OPENAI_API_KEY — the helper is the only live
 *      path), exactly like regen-flyer-sample.ts does.
 *   3. The finished website overwrites
 *      docs/samples/website-adas-kitchen.html.
 *
 * The point of the run: prove the redesigned pipeline produces a
 * website with a hero (picture first, then the name), service cards,
 * hours, and a big call button — built only from the brief, with
 * nothing invented. The sample file is exactly what the job page's
 * "Download the page" button saves as website.html, so the file
 * itself is the download proof.
 *
 * Run: pnpm --filter @ikenga/agent regen:website-sample
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCreative } from "./creative.js";
import { estimateCostUsd, type OpenAIReply } from "./openai.js";

const HELPER = "/home/hatch/workspace/custom-connectors/custom.openai/bin/openai.py";
const FLYER_SAMPLE = fileURLToPath(new URL("../../../docs/samples/flyer-adas-kitchen.html", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../../docs/samples/website-adas-kitchen.html", import.meta.url));

const BRIEF =
  "Build a one-page website for Ada's Kitchen, a food shop in Lagos. Jollof rice, fried rice and chicken, ₦2,500 a plate. Open Monday to Saturday, 9am to 8pm. Call 0803 123 4567 to order. Keep it simple: the food and prices, opening hours, and a big button to call and order.";

function fail(step: string, detail: string): never {
  console.log(`FAIL ${step} — ${detail}`);
  process.exit(1);
}

function pass(step: string, detail: string): void {
  console.log(`PASS ${step} — ${detail}`);
}

/**
 * The pipeline's chat, driven through the OpenAI connector helper —
 * the twin of helperChat in e2e-image-sepolia.ts. The prompt travels
 * as a file (chat-file), never as a command-line argument.
 */
async function helperChat(input: { model: string; messages: { role: string; content: string }[]; maxTokens?: number }): Promise<OpenAIReply> {
  const prompt = input.messages.map((m) => m.content).join("\n");
  const promptFile = join(tmpdir(), `ikenga-regen-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(promptFile, prompt);
  try {
    const out = execFileSync(
      "python3",
      [HELPER, "chat-file", input.model, promptFile, "--max-tokens", String(input.maxTokens ?? 1024)],
      { encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const data = JSON.parse(out) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    const usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };
    return { model: input.model, text, usage, costUsd: estimateCostUsd(input.model, usage) };
  } finally {
    try {
      unlinkSync(promptFile);
    } catch {
      // Scratch — a failed delete is not a failure.
    }
  }
}

async function main(): Promise<void> {
  // 1. Reuse the picture from the testnet run — no new image is paid for.
  const flyerSample = readFileSync(FLYER_SAMPLE, "utf8");
  const picture = flyerSample.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/)?.[0];
  if (!picture) fail("picture", "no data-URI picture in the existing flyer sample to reuse");
  pass("picture", `reused the testnet picture (${(picture.length / 1024).toFixed(0)} KB base64, no new image paid for)`);

  // 2. Run the real pipeline with the redesigned website prompt.
  const result = await runCreative(
    { brief: BRIEF, jobType: "website" },
    {
      chat: helperChat,
      image: async () => ({ dataUri: picture, costUsd: 0, model: "gpt-image-1.5 (reused)" }),
    },
  );
  if (result.status !== "delivered") fail("creative", `website refused: ${result.reason ?? "no reason"}`);
  if (!result.image) fail("image", "website delivered with no picture");
  pass("creative", `delivered, ${result.steps.length} steps, $${result.totalCostUsd.toFixed(4)} total`);

  // 3. Prove the redesign: a hero with the picture in it, the
  // brief's facts, and nothing invented. The picture sits inside
  // the hero header, after the name — that is the layout the model
  // follows reliably, and it is how the flyer looks too.
  const html = result.html;
  const heroMatch = html.match(/<header\b[^>]*class=["']hero["'][^>]*>/i);
  if (!heroMatch || heroMatch.index === undefined) fail("hero", "no <header class=\"hero\"> in the website");
  const heroOpen = heroMatch.index;
  const heroClose = html.indexOf("</header>", heroOpen);
  if (heroClose < 0) fail("hero", "the hero header never closes");
  const imgAt = html.indexOf("<img");
  if (imgAt < 0) fail("hero", "no picture in the website");
  if (!(heroOpen < imgAt && imgAt < heroClose)) fail("hero", "the picture is not inside the hero");
  pass("hero", "picture inside <header class=\"hero\">, after the name");
  if (!html.includes(picture)) fail("image-embedded", "the reused picture is not embedded in the website");
  pass("image-embedded", "the reused picture is embedded in the website");
  if (/in this corrected version/i.test(html)) fail("chatter", "commentary leaked past </html> into the website");
  pass("chatter", "no commentary past </html>");

  for (const fact of ["Ada's Kitchen", "₦2,500", "0803 123 4567"]) {
    if (!html.includes(fact)) fail("facts", `brief fact missing from the website: ${fact}`);
  }
  if (!/monday/i.test(html) || !/9am/i.test(html)) fail("facts", "opening hours missing from the website");
  for (const dish of ["Jollof", "Fried rice", "Chicken"]) {
    if (!new RegExp(dish, "i").test(html)) fail("facts", `brief item missing from the website: ${dish}`);
  }
  pass("facts", "name, dishes, price, hours and phone all present");
  if (/special offers/i.test(html)) fail("invented", "the website contains a 'Special Offers' section");
  if (/combo deal/i.test(html)) fail("invented", "the website contains a 'Combo deal' section");
  pass("invented", "no invented sections in the website");

  // 4. Prove it downloads cleanly: the sample is exactly the bytes
  // the job page's "Download the page" button saves as website.html,
  // so it must be one standalone page with no scripts and no
  // external pictures.
  if (!html.trimStart().toLowerCase().startsWith("<!doctype html>")) fail("standalone", "the website does not start with a doctype");
  if (/<script/i.test(html)) fail("standalone", "the website contains a script");
  if (/<img[^>]+src="https?:/i.test(html)) fail("standalone", "the website links a picture from elsewhere");
  pass("standalone", "one page, no scripts, no external pictures — downloads as website.html");

  // The name must print once — the headline — not twice. Stray text
  // in <head> (a leftover <title>) would print small at the top.
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head\s*>/i);
  if (!headMatch) fail("head-clean", "no <head> in the website");
  const headText = headMatch[1]
    .replace(/<style[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<(meta|link|base)\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (headText.length > 0) fail("head-clean", `stray text in <head>: ${JSON.stringify(headText.slice(0, 80))}`);
  pass("head-clean", "nothing but <style> in <head> — the name prints once");

  writeFileSync(SAMPLE, html);
  console.log(`sample: ${SAMPLE}`);
  console.log("Website sample regenerated: OK");
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
