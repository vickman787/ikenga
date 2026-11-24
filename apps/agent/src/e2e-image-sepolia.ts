/**
 * Image + download proof on Celo Sepolia — one flyer job and one
 * promo-video job, end to end, with the new build:
 *
 *   1. deploy a per-job JobEscrow (tagged), approve + fund 1 test
 *      USDC (tagged) — the exact call sequence the browser runs
 *   2. the creative pipeline, with its chat AND its picture driven
 *      through the OpenAI connector helper (the repo has no local
 *      OPENAI_API_KEY — the helper is the only live path)
 *   3. boss: vault.registerEscrow + vault.submitDeliverable (tagged),
 *      sealing the real fingerprint of the delivered work
 *   4. customer accept() (tagged) — the $1 lands in the vault
 *
 * Every customer and boss transaction's input is read back from the
 * chain and checked for the tag with parseAttribution.
 *
 * The finished work is saved as the samples the user reviews:
 * docs/samples/flyer-adas-kitchen.html and
 * docs/samples/slideshow-adas-kitchen.html (the standalone download
 * file), plus docs/samples/testnet-run.json with every hash.
 *
 * Run:  IKENGA_LIVE_TESTS=1 pnpm --filter @ikenga/agent exec:image-sepolia
 *
 * Sepolia only — it never touches mainnet. Exits non-zero on the
 * first failure. It spends real test USDC (2 x $1) and real OpenAI
 * credit (chat + 2 pictures, a few cents).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { celoSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { appendAttribution, deliverableHashFor, parseAttribution, readVaultOnchain } from "@ikenga/payments";
import { buildStandaloneSlideshowHtml } from "@ikenga/shared";
import { runCreative, type CreativeJobType } from "./creative.js";
import { estimateCostUsd } from "./openai.js";
import type { OpenAIReply } from "./openai.js";
import { imageCostUsd, OPENAI_IMAGE_MODEL, OPENAI_IMAGE_PRICE_USD, type ImageResult } from "./images.js";

const RPC = process.env.CELO_SEPOLIA_RPC_URL ?? "https://rpc.ankr.com/celo_sepolia";
const PRICE = 1_000_000n;
const HELPER = "/home/hatch/workspace/custom-connectors/custom.openai/bin/openai.py";
const SAMPLES_DIR = fileURLToPath(new URL("../../../docs/samples/", import.meta.url));

const JOBS: { jobType: CreativeJobType; label: string; brief: string }[] = [
  {
    jobType: "flyers",
    label: "flyer",
    brief:
      "Make a simple flyer and price list for Ada's Kitchen, a food shop in Lagos. Jollof rice ₦2,500, fried rice ₦2,500, chicken ₦2,000, small chops ₦1,500. Open Monday to Saturday, 9am to 8pm. Call 0803 123 4567 to order. Keep it clean and easy to read.",
  },
  {
    jobType: "promo-video",
    label: "promo video",
    brief:
      "Make a short promo video for Ada's Kitchen, a food shop in Lagos. Show jollof rice, fried rice and chicken, ₦2,500 a plate. Open Monday to Saturday, 9am to 8pm. Call 0803 123 4567 to order. Keep it bright, simple, and easy to read on a phone.",
  },
];

function loadEnv(): void {
  try {
    const raw = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // No .env — env vars must already be set.
  }
}

function fail(step: string, detail: string): never {
  console.log(`FAIL ${step} — ${detail}`);
  process.exit(1);
}

function pass(step: string, detail: string): void {
  console.log(`PASS ${step} — ${detail}`);
}

const escrowAbi = parseAbi([
  "constructor(address customer, address vault, address token, uint256 bondAmount, uint256 price, bytes32 specHash)",
  "function fund()",
  "function accept()",
  "function state() view returns (uint8)",
  "function price() view returns (uint256)",
  "function deliverableHash() view returns (bytes32)",
]);

const vaultAbi = parseAbi([
  "function registerEscrow(address escrow)",
  "function submitDeliverable(address escrow, bytes32 deliverableHash)",
  "function registeredEscrow(address escrow) view returns (bool)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

/**
 * The pipeline's chat, driven through the OpenAI connector helper —
 * the repo has no local OPENAI_API_KEY, and the helper is the only
 * live path to the key. The prompt travels as a file (chat-file),
 * never as a command-line argument.
 */
async function helperChat(input: { model: string; messages: { role: string; content: string }[]; maxTokens?: number }): Promise<OpenAIReply> {
  const prompt = input.messages.map((m) => m.content).join("\n");
  const promptFile = join(tmpdir(), `ikenga-e2e-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
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
      // The prompt file is scratch — a failed delete is not a failure.
    }
  }
}

/**
 * The pipeline's picture, driven through the helper's images command.
 * The base64 travels as a file (--out), never on stdout. A throw
 * means the picture service did not answer — the pipeline then
 * delivers without a picture, and this script fails the run on the
 * missing picture (the point of the proof is the picture step).
 */
async function helperImage(input: { prompt: string }): Promise<ImageResult | null> {
  const outFile = join(tmpdir(), `ikenga-e2e-image-${Date.now()}-${Math.random().toString(36).slice(2)}.b64`);
  const out = execFileSync(
    "python3",
    [HELPER, "images", input.prompt, "--out", outFile],
    { encoding: "utf8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const summary = JSON.parse(out) as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  const b64 = readFileSync(outFile, "utf8").trim();
  try {
    unlinkSync(outFile);
  } catch {
    // Scratch — a failed delete is not a failure.
  }
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) fail("image", "the helper wrote no picture");
  const costUsd = summary.usage ? imageCostUsd(summary.usage) : OPENAI_IMAGE_PRICE_USD;
  return { dataUri: `data:image/jpeg;base64,${b64}`, costUsd, model: summary.model ?? OPENAI_IMAGE_MODEL };
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env.IKENGA_LIVE_TESTS !== "1") {
    fail("live-gate", "set IKENGA_LIVE_TESTS=1 to run live checks");
  }
  const key = process.env.IKENGA_TEST_PRIVATE_KEY;
  if (!key) fail("test-key", "IKENGA_TEST_PRIVATE_KEY not set");
  const tag = process.env.IKENGA_ATTRIBUTION_TAG;
  if (!tag || !/^celo_[0-9a-fA-F]{12}$/.test(tag)) {
    fail("tag", "IKENGA_ATTRIBUTION_TAG not set or malformed — never invent a tag");
  }
  const account = privateKeyToAccount(key as Hex);
  const customer = account.address;

  const deployed = JSON.parse(
    readFileSync(new URL("../../../contracts/deployments/celo-sepolia.json", import.meta.url), "utf8"),
  );
  const vault = (deployed.vault ?? deployed.IkengaVault) as Address;
  const token = "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as Address;
  if (!vault) fail("contracts", "no Sepolia vault in contracts/deployments/celo-sepolia.json");

  const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: celoSepolia, transport: http(RPC) });

  const artifact = JSON.parse(
    readFileSync(new URL("../../../contracts/out/JobEscrow.sol/JobEscrow.json", import.meta.url), "utf8"),
  );
  const bytecode = artifact.bytecode.object as Hex;

  // Balances first: 2 jobs need 2 test USDC for funding, plus gas.
  const celoBal = await pub.getBalance({ address: customer });
  const usdcBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [customer] });
  console.log(`wallet ${customer}: ${(Number(celoBal) / 1e18).toFixed(4)} CELO, ${(Number(usdcBal) / 1e6).toFixed(2)} test USDC`);
  if (usdcBal < 2_000_000n) fail("funds", `only ${(Number(usdcBal) / 1e6).toFixed(2)} test USDC — 2.00 needed for two $1 jobs`);
  if (celoBal < 200_000_000_000_000_000n) fail("funds", `only ${(Number(celoBal) / 1e18).toFixed(4)} CELO — 0.20 needed for gas`);

  /** Send one tagged call exactly the way the browser (and the boss
   * worker) does, then read the transaction back from the chain and
   * prove the tag is on it. */
  async function sendTagged(label: string, to: Address | undefined, data: Hex): Promise<Hex> {
    const tagged = appendAttribution(data, tag as string);
    const txHash = await wallet.sendTransaction({ account, chain: celoSepolia, ...(to ? { to } : {}), data: tagged });
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") fail(`${label}:receipt`, `tx ${txHash} did not succeed`);
    const tx = await pub.getTransaction({ hash: txHash });
    const parsed = parseAttribution(tx.input);
    if (!parsed || !parsed.codes.includes(tag as string)) {
      fail(`${label}:tag`, `tx ${txHash} carries no ${tag} tag in its input`);
    }
    pass(`${label}:tag`, `tx ${txHash} carries ${tag}`);
    return txHash;
  }

  mkdirSync(SAMPLES_DIR, { recursive: true });
  const manifest: Record<string, unknown> = { ranAt: new Date().toISOString(), chain: "celo-sepolia", jobs: [] as unknown[] };

  for (const job of JOBS) {
    console.log(`\n=== ${job.label} job (${job.jobType}) ===`);
    const vaultBefore = await readVaultOnchain(vault, token, { rpcUrl: RPC });
    const txs: Record<string, string> = {};

    // 1. Deploy the escrow — tagged.
    const specHash = keccak256(toHex(`Ikenga image e2e ${job.jobType} ${Date.now()}`));
    const deployData = encodeDeployData({
      abi: escrowAbi,
      bytecode,
      args: [customer, vault, token, 0n, PRICE, specHash],
    });
    txs.deploy = await sendTagged("deploy", undefined, deployData);
    const deployReceipt = await pub.waitForTransactionReceipt({ hash: txs.deploy as Hex });
    const escrow = deployReceipt.contractAddress;
    if (!escrow) fail("deploy", "no contract address in receipt");
    pass("deploy", `escrow ${escrow}`);

    // 2. Approve + fund — tagged.
    txs.approve = await sendTagged(
      "approve",
      token,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [escrow, PRICE] }),
    );
    txs.fund = await sendTagged(
      "fund",
      escrow,
      encodeFunctionData({ abi: escrowAbi, functionName: "fund", args: [] }),
    );
    const stateAfterFund = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
    const escrowBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [escrow] });
    if (Number(stateAfterFund) !== 1 || escrowBal !== PRICE) {
      fail("fund", `state=${stateAfterFund} escrowBal=${escrowBal}, expected state 1 and ${PRICE}`);
    }
    pass("fund", `escrow holds exactly ${PRICE}`);

    // 3. The team runs — chat and picture through the helper. This is
    // what auto-start does on the server after the $1 is confirmed.
    const result = await runCreative({ brief: job.brief, jobType: job.jobType }, { chat: helperChat, image: helperImage });
    if (result.status !== "delivered") {
      fail("creative", `${job.label} refused: ${result.reason ?? "no reason"}`);
    }
    if (!result.image) fail("image", `${job.label} delivered with no picture — the picture step is the point of this run`);
    const imageStep = result.steps.find((s) => s.what.includes("Made one picture"));
    console.log(`creative: delivered, ${result.steps.length} steps, $${result.totalCostUsd.toFixed(4)} total, picture ${imageStep?.model ?? "?"} $${(imageStep?.costUsd ?? 0).toFixed(4)}`);
    pass("creative", `${job.label} delivered with a picture`);

    // 4. Boss: register + seal the real fingerprint — tagged.
    txs.register = await sendTagged(
      "register",
      vault,
      encodeFunctionData({ abi: vaultAbi, functionName: "registerEscrow", args: [escrow] }),
    );
    const content = job.jobType === "promo-video" ? { slides: result.slides } : { html: result.html };
    const hash = deliverableHashFor(content);
    txs.seal = await sendTagged(
      "seal",
      vault,
      encodeFunctionData({ abi: vaultAbi, functionName: "submitDeliverable", args: [escrow, hash] }),
    );
    const sealed = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "deliverableHash" });
    if (sealed !== hash) fail("seal", "deliverable hash not sealed on the escrow");
    pass("seal", `fingerprint ${hash} sealed`);

    // 5. Accept — tagged. The $1 must land in the vault's OPERATING pot.
    txs.accept = await sendTagged(
      "accept",
      escrow,
      encodeFunctionData({ abi: escrowAbi, functionName: "accept", args: [] }),
    );
    const state = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
    const vaultAfter = await readVaultOnchain(vault, token, { rpcUrl: RPC });
    const operatingDelta = (vaultAfter.buckets?.operating ?? 0n) - (vaultBefore.buckets?.operating ?? 0n);
    if (Number(state) !== 2 || operatingDelta !== PRICE) {
      fail("accept", `state=${state} operatingDelta=${operatingDelta}, expected 2 and ${PRICE}`);
    }
    pass("accept", `escrow ACCEPTED, vault operating +${PRICE}`);

    // 6. The samples the user reviews are the actual deliverables.
    const sampleFiles: Record<string, string> = {};
    if (job.jobType === "promo-video") {
      const file = join(SAMPLES_DIR, "slideshow-adas-kitchen.html");
      writeFileSync(file, buildStandaloneSlideshowHtml(result.slides));
      sampleFiles.slideshow = file;
    } else {
      const file = join(SAMPLES_DIR, "flyer-adas-kitchen.html");
      writeFileSync(file, result.html);
      sampleFiles.flyer = file;
    }
    (manifest.jobs as Record<string, unknown>[]).push({
      label: job.label,
      jobType: job.jobType,
      escrow,
      txs,
      deliverableHash: hash,
      image: { model: imageStep?.model ?? null, costUsd: imageStep?.costUsd ?? null },
      totalCostUsd: result.totalCostUsd,
      samples: sampleFiles,
    });
    console.log(`samples: ${Object.values(sampleFiles).join(", ")}`);
  }

  writeFileSync(join(SAMPLES_DIR, "testnet-run.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nmanifest: ${join(SAMPLES_DIR, "testnet-run.json")}`);
  console.log("Image + download proof on Sepolia: ALL PASS");
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
