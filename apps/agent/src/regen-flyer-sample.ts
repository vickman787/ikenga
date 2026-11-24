/**
 * Regenerate the flyer sample with the fixed creative pipeline — no
 * Sepolia money, no new picture.
 *
 *   1. The picture is reused from the testnet run: the data URI is
 *      read out of the existing docs/samples/flyer-adas-kitchen.html.
 *      No new image is paid for.
 *   2. The chat runs through the OpenAI connector helper (the repo
 *      has no local OPENAI_API_KEY — the helper is the only live
 *      path), exactly like e2e-image-sepolia.ts does.
 *   3. The finished flyer overwrites docs/samples/flyer-adas-kitchen.html.
 *
 * The point of the run: prove the corrected pipeline produces a
 * flyer with exactly the four items in the brief and no invented
 * row ("Special Offers" was the slip that prompted this fix). The
 * script fails loudly if the flyer is refused, has no picture, is
 * missing a brief item, or still carries an invented row.
 *
 * Run: pnpm --filter @ikenga/agent regen:flyer-sample
 */
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCreative } from "./creative.js";
import { estimateCostUsd, type OpenAIReply } from "./openai.js";

const HELPER = "/home/hatch/workspace/custom-connectors/custom.openai/bin/openai.py";
const SAMPLE = fileURLToPath(new URL("../../../docs/samples/flyer-adas-kitchen.html", import.meta.url));

const BRIEF =
  "Make a simple flyer and price list for Ada's Kitchen, a food shop in Lagos. Jollof rice ₦2,500, fried rice ₦2,500, chicken ₦2,000, small chops ₦1,500. Open Monday to Saturday, 9am to 8pm. Call 0803 123 4567 to order. Keep it clean and easy to read.";

const EXPECTED_ITEMS = ["Jollof rice", "Fried rice", "Chicken", "Small chops"];

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
  const oldSample = readFileSync(SAMPLE, "utf8");
  const picture = oldSample.match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/)?.[0];
  if (!picture) fail("picture", "no data-URI picture in the existing sample to reuse");
  pass("picture", `reused the testnet picture (${(picture.length / 1024).toFixed(0)} KB base64, no new image paid for)`);

  // 2. Run the real pipeline with the fixed prompts and guard.
  const result = await runCreative(
    { brief: BRIEF, jobType: "flyers" },
    {
      chat: helperChat,
      image: async () => ({ dataUri: picture, costUsd: 0, model: "gpt-image-1.5 (reused)" }),
    },
  );
  if (result.status !== "delivered") fail("creative", `flyer refused: ${result.reason ?? "no reason"}`);
  if (!result.image) fail("image", "flyer delivered with no picture");
  pass("creative", `delivered, ${result.steps.length} steps, $${result.totalCostUsd.toFixed(4)} total`);

  // 3. Prove the fix: exactly the four brief items, no invented row.
  for (const item of EXPECTED_ITEMS) {
    if (!result.html.includes(item)) fail("items", `brief item missing from the flyer: ${item}`);
  }
  pass("items", "all four brief items present");
  if (/special offers/i.test(result.html)) fail("invented-row", "the flyer still contains a 'Special Offers' row");
  if (/combo deal/i.test(result.html)) fail("invented-row", "the flyer contains a 'Combo deal' row");
  pass("invented-row", "no invented price row in the flyer");
  if (!result.html.includes(picture)) fail("image-embedded", "the reused picture is not embedded in the flyer");
  pass("image-embedded", "the reused picture is embedded in the flyer");

  writeFileSync(SAMPLE, result.html);
  console.log(`sample: ${SAMPLE}`);
  console.log("Flyer sample regenerated: OK");
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
