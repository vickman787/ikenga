/**
 * Boss worker — the one half of the $1 flow the browser and the server
 * cannot do on their own.
 *
 * Per-job escrows are deployed from the customer's browser and funded
 * there, but two calls are boss-only on the vault, and the Vercel
 * server does not hold the boss key:
 *   1. vault.registerEscrow(escrow) — until the vault knows the escrow,
 *      accept() reverts (creditEscrowRelease is onlyEscrow) and the
 *      deliverable cannot be sealed (submitDeliverable needs a
 *      registered escrow).
 *   2. vault.submitDeliverable(escrow, hash) — seals the delivered
 *      work's fingerprint on the escrow, which accept() requires.
 *
 * This worker fills that gap. It is API-driven: it lists jobs from the
 * site (GET /api/jobs), reads each delivered job's report the same way
 * (GET /api/jobs/[id]), and records a seal back through
 * POST /api/jobs/[id]/deliverable. It holds no database connection —
 * the site is the source of truth.
 *
 * Each currency has its own vault — a USDT escrow registers and seals
 * in the USDT vault, a cNGN escrow in the cNGN vault. The worker never
 * assumes which: the escrow itself names its vault onchain
 * (ikengaVault), and the worker reads that per escrow, checking the
 * boss of that vault before acting. The vault in the config is only
 * the chain guard — the site and the worker must agree on the chain's
 * defaults before anything moves.
 *
 * Run:  pnpm --filter @ikenga/agent boss
 * Env:  IKENGA_CHAIN (mainnet|sepolia, default mainnet)
 *       IKENGA_SITE_URL (default https://ikenga-two.vercel.app)
 *       IKENGA_BOSS_PRIVATE_KEY (mainnet = the agent key, Sepolia =
 *         the test key; never print it, never write it to a file).
 *         When unset, mainnet falls back to IKENGA_AGENT_PRIVATE_KEY
 *         and Sepolia to IKENGA_TEST_PRIVATE_KEY — the names the keys
 *         already live under in the repo's .env, so no secret is ever
 *         duplicated under a second name. An explicit
 *         IKENGA_BOSS_PRIVATE_KEY always wins.
 *       IKENGA_VAULT_ADDRESS / IKENGA_TOKEN_ADDRESS (Sepolia must set
 *         both; mainnet defaults to the deployed contracts)
 *       CELO_RPC_URL (default https://rpc.ankr.com/celo)
 *       CELO_SEPOLIA_RPC_URL (default https://rpc.ankr.com/celo_sepolia)
 *       IKENGA_ATTRIBUTION_TAG (required — every boss tx is tagged)
 *       IKENGA_ENV_FILE (optional path to a .env to load missing vars
 *         from; defaults to the repo root .env, then ./ .env)
 *
 * Missing vars are also read from the repo's .env (the same file the
 * keys already live in) — the worker never invents a key and never
 * prints one. It no-ops when there is nothing to do, so it is safe to
 * run on a schedule. It never touches a job on the wrong chain: the
 * site's /api/chain is checked first, and a mismatch stops the run.
 *
 * Cap: 10 on-chain actions per run. Every boss transaction goes
 * through the repo's own sendTagged(), so it carries the ERC-8021
 * attribution tag.
 *
 * Pass 3 — naira bills (mainnet only: there is no Celo testnet
 * corridor). The worker polls GET /api/bills and runs the pipeline in
 * ./bills.ts: live preview, funding check, firm quote at or above the
 * bill's minimum rate (refuse + receipt below it, force-convert at the
 * deadline), the Textile swap, then the tagged cNGN payout to the
 * supplier. Tagging: the USDT approval is tagged, the swap is broadcast
 * exactly as Textile returns it (never re-tagged — it carries Textile's
 * tag), the payout is tagged. The site may not serve /api/bills yet
 * (the bills code ships before the site redeploys) — a 404 skips the
 * pass quietly instead of failing the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celo, celoSepolia } from "viem/chains";
import {
  deliverableHashFor,
  readEscrowOnchain,
  sendTagged,
  TextileClient,
  type TakerSigner,
  type DeliverableContent,
} from "@ikenga/payments";
import { CNGN_ADDRESS, processBills, type BillRuntime, type SiteBill } from "./bills.js";

/** Mainnet contracts, deployed 2026-11-23 (contracts/deployments/celo.json). Public addresses, not secrets. */
export const MAINNET_VAULT_ADDRESS = "0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B" as Address;
export const MAINNET_TOKEN_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address;
export const MAINNET_CHAIN_ID = 42220;
export const SEPOLIA_CHAIN_ID = 11142220;
export const CELO_MAINNET_RPC_URL = "https://rpc.ankr.com/celo";
export const CELO_SEPOLIA_RPC_URL = "https://rpc.ankr.com/celo_sepolia";
export const DEFAULT_SITE_URL = "https://ikenga-two.vercel.app";
/** On-chain actions per run — a run that hits the cap leaves the rest for the next run. */
export const MAX_ACTIONS_PER_RUN = 10;
/** Job statuses where an escrow may still need registering. Accepted /
 * refunded / rejected jobs are done — registering theirs helps no one. */
const REGISTERABLE_STATUSES = new Set(["draft", "escrowed", "in-progress", "delivered"]);
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;

const VAULT_ABI = parseAbi([
  "function registerEscrow(address escrow)",
  "function submitDeliverable(address escrow, bytes32 deliverableHash)",
  "function registeredEscrow(address escrow) view returns (bool)",
  "function boss() view returns (address)",
]);

const ESCROW_READ_ABI = parseAbi(["function deliverableHash() view returns (bytes32)"]);

export interface BossConfig {
  chain: "mainnet" | "sepolia";
  chainId: number;
  siteUrl: string;
  rpcUrl: string;
  vaultAddress: Address;
  tokenAddress: Address;
  bossPrivateKey: Hex;
  attributionTag: string;
}

export interface BossSiteJob {
  id: string;
  status: string;
  escrowAddress: string | null;
  deliverableTxHash: string | null;
}

/**
 * Parse a .env file into key/value pairs. Comments and blank lines are
 * skipped; `export ` prefixes and surrounding quotes are stripped.
 * Pure — easy to test, and it never logs a value.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Fill in any missing env vars from a .env file. Existing env wins —
 * the file is a fallback, never an override. Candidate locations, in
 * order: IKENGA_ENV_FILE, <cwd>/.env, the repo root .env (three levels
 * above this file's dist/ or src/ directory: agent/dist → agent →
 * apps → repo root). Silent when no file is found — the config step
 * below reports exactly what is missing.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.IKENGA_ENV_FILE,
    resolve(process.cwd(), ".env"),
    resolve(here, "../../../.env"),
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = parseEnvFile(readFileSync(path, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (env[key] === undefined || env[key] === "") env[key] = value;
      }
      return;
    } catch {
      // An unreadable .env is not fatal — config resolution reports it.
      continue;
    }
  }
}

/** Resolve and validate the worker's config from env. Throws in plain words when something is missing. */
export function resolveBossConfig(env: NodeJS.ProcessEnv = process.env): BossConfig {
  const chainRaw = (env.IKENGA_CHAIN ?? "mainnet").toLowerCase();
  if (chainRaw !== "mainnet" && chainRaw !== "sepolia") {
    throw new Error(`IKENGA_CHAIN must be "mainnet" or "sepolia", got "${chainRaw}".`);
  }
  const chain = chainRaw as "mainnet" | "sepolia";
  const chainId = chain === "mainnet" ? MAINNET_CHAIN_ID : SEPOLIA_CHAIN_ID;
  const siteUrl = (env.IKENGA_SITE_URL ?? DEFAULT_SITE_URL).replace(/\/$/, "");
  const rpcUrl =
    chain === "mainnet"
      ? (env.CELO_RPC_URL ?? CELO_MAINNET_RPC_URL)
      : (env.CELO_SEPOLIA_RPC_URL ?? CELO_SEPOLIA_RPC_URL);
  let vaultAddress = env.IKENGA_VAULT_ADDRESS as Address | undefined;
  let tokenAddress = env.IKENGA_TOKEN_ADDRESS as Address | undefined;
  if (chain === "mainnet") {
    vaultAddress ??= MAINNET_VAULT_ADDRESS;
    tokenAddress ??= MAINNET_TOKEN_ADDRESS;
  }
  if (!vaultAddress || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    throw new Error(
      "IKENGA_VAULT_ADDRESS is not set (Sepolia has no shipped default — set it to the Sepolia vault).",
    );
  }
  if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new Error(
      "IKENGA_TOKEN_ADDRESS is not set (Sepolia has no shipped default — set it to the Sepolia token).",
    );
  }
  // The boss key: explicit IKENGA_BOSS_PRIVATE_KEY wins. Otherwise
  // mainnet uses the agent key and Sepolia the test key — the names
  // they already live under in the repo's .env (see the header).
  const bossPrivateKey = (env.IKENGA_BOSS_PRIVATE_KEY ??
    (chain === "mainnet" ? env.IKENGA_AGENT_PRIVATE_KEY : env.IKENGA_TEST_PRIVATE_KEY)) as Hex | undefined;
  if (!bossPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(bossPrivateKey)) {
    throw new Error(
      "No boss key found: set IKENGA_BOSS_PRIVATE_KEY (or IKENGA_AGENT_PRIVATE_KEY on mainnet / IKENGA_TEST_PRIVATE_KEY on Sepolia) to a 0x… 64-hex private key.",
    );
  }
  const attributionTag = env.IKENGA_ATTRIBUTION_TAG;
  if (!attributionTag) {
    throw new Error("IKENGA_ATTRIBUTION_TAG is not set — boss transactions must carry the attribution tag.");
  }
  return { chain, chainId, siteUrl, rpcUrl, vaultAddress, tokenAddress, bossPrivateKey, attributionTag };
}

/** The delivered work for a job, as the seal hash needs it — the same
 * fields the server's deliverableHashFor() reads (report text, page
 * HTML, slides). Null when the report carries no deliverable content
 * at all (nothing real to seal). */
export function reportToDeliverableContent(report: {
  report?: string;
  html?: string;
  slides?: { title: string; text: string }[];
} | null): DeliverableContent | null {
  if (!report) return null;
  const content: DeliverableContent = {};
  if (report.report) content.report = report.report;
  if (report.html) content.html = report.html;
  if (report.slides && report.slides.length > 0) content.slides = report.slides;
  return Object.keys(content).length > 0 ? content : null;
}

interface ChainInfo {
  chainId: number;
  vaultAddress: string;
  tokenAddress: string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export async function runBossWorker(env: NodeJS.ProcessEnv = process.env): Promise<{
  registered: number;
  sealed: number;
  billsChecked: number;
  billsConverted: number;
  billsPaid: number;
}> {
  loadEnvFile(env);
  const config = resolveBossConfig(env);
  const log = (msg: string) => console.log(`[boss:${config.chain}] ${msg}`);

  log(`site ${config.siteUrl} — vault ${config.vaultAddress}`);

  // Never touch jobs on the wrong chain: the site says which chain it
  // runs on, and a mismatch stops the run before any transaction.
  const chainRes = await fetchJson(`${config.siteUrl}/api/chain`);
  const chainInfo = chainRes.body as unknown as ChainInfo;
  if (chainRes.status !== 200 || !chainInfo.chainId) {
    throw new Error(`Could not read ${config.siteUrl}/api/chain (HTTP ${chainRes.status}) — refusing to act blind.`);
  }
  if (chainInfo.chainId !== config.chainId) {
    throw new Error(
      `Chain mismatch: the site runs on chain ${chainInfo.chainId}, the worker is set to ${config.chain} (${config.chainId}). Refusing to act.`,
    );
  }
  if (chainInfo.vaultAddress?.toLowerCase() !== config.vaultAddress.toLowerCase()) {
    throw new Error(
      `Vault mismatch: the site uses ${chainInfo.vaultAddress}, the worker is set to ${config.vaultAddress}. Refusing to act.`,
    );
  }
  if (chainInfo.tokenAddress?.toLowerCase() !== config.tokenAddress.toLowerCase()) {
    throw new Error(
      `Token mismatch: the site uses ${chainInfo.tokenAddress}, the worker is set to ${config.tokenAddress}. Refusing to act.`,
    );
  }
  log(`chain ${chainInfo.chainId} confirmed — site and worker agree.`);

  const viemChain = config.chain === "mainnet" ? celo : celoSepolia;
  const publicClient: PublicClient = createPublicClient({ transport: http(config.rpcUrl) });
  const account = privateKeyToAccount(config.bossPrivateKey);
  const walletClient: WalletClient = createWalletClient({ account, chain: viemChain, transport: http(config.rpcUrl) });

  // The vault only takes boss calls from its boss. Check before
  // spending gas on transactions that would revert.
  const vaultBoss = await publicClient.readContract({
    address: config.vaultAddress,
    abi: VAULT_ABI,
    functionName: "boss",
  });
  if (vaultBoss.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `Boss key mismatch: the vault's boss is ${vaultBoss}, but the key given belongs to ${account.address}. Refusing to act.`,
    );
  }
  log(`boss ${account.address} confirmed against the vault.`);

  // Each currency has its own vault — USDT escrows register and seal in
  // the USDT vault, cNGN escrows in the cNGN vault. The escrow itself
  // names its vault (ikengaVault), so resolve it per escrow and check
  // the boss of THAT vault before acting; the primary vault above is
  // only the chain guard, proving the site and the worker agree on the
  // chain's defaults. Boss checks are cached per vault within a run.
  // The read uses this worker's RPC, so Sepolia runs read Sepolia.
  const bossByVault = new Map<string, boolean>();
  async function vaultForEscrow(escrow: Address, jobId: string): Promise<Address | null> {
    let onchain;
    try {
      onchain = await readEscrowOnchain(escrow, { rpcUrl: config.rpcUrl });
    } catch (err) {
      log(`job ${jobId}: could not read escrow ${escrow} onchain — skipping. (${err instanceof Error ? err.message : "unknown error"})`);
      return null;
    }
    if (!onchain.exists || !onchain.vault) {
      log(`job ${jobId}: escrow ${escrow} is not on the chain, or names no vault — skipping.`);
      return null;
    }
    const vault = onchain.vault as Address;
    const key = vault.toLowerCase();
    if (!bossByVault.has(key)) {
      const boss = await publicClient.readContract({ address: vault, abi: VAULT_ABI, functionName: "boss" });
      if (boss.toLowerCase() !== account.address.toLowerCase()) {
        log(`job ${jobId}: the escrow's vault ${vault} has a different boss (${boss}) — refusing to act on this escrow.`);
        bossByVault.set(key, false);
        return null;
      }
      bossByVault.set(key, true);
      if (vault.toLowerCase() !== config.vaultAddress.toLowerCase()) {
        log(`boss ${account.address} confirmed against vault ${vault}.`);
      }
    } else if (!bossByVault.get(key)) {
      return null;
    }
    return vault;
  }

  const jobsRes = await fetchJson(`${config.siteUrl}/api/jobs`);
  if (jobsRes.status !== 200 || !Array.isArray(jobsRes.body.jobs)) {
    throw new Error(`Could not list jobs from ${config.siteUrl}/api/jobs (HTTP ${jobsRes.status}).`);
  }
  const jobs = jobsRes.body.jobs as BossSiteJob[];
  log(`${jobs.length} job(s) on the site.`);

  let actions = 0;
  let registered = 0;
  let sealed = 0;

  // Pass 1 — register: any live job whose escrow the vault doesn't
  // know yet. Without this, accept() reverts and sealing is impossible.
  for (const job of jobs) {
    if (actions >= MAX_ACTIONS_PER_RUN) break;
    if (!job.escrowAddress || !REGISTERABLE_STATUSES.has(job.status)) continue;
    const escrow = job.escrowAddress as Address;
    const vault = await vaultForEscrow(escrow, job.id);
    if (!vault) continue;
    let known: boolean;
    try {
      known = await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "registeredEscrow",
        args: [escrow],
      });
    } catch (err) {
      log(`job ${job.id}: could not read registeredEscrow(${escrow}) — skipping. (${err instanceof Error ? err.message : "unknown error"})`);
      continue;
    }
    if (known) continue;
    log(`job ${job.id}: registering escrow ${escrow} in the vault…`);
    const { hash } = await sendTagged(
      walletClient,
      {
        to: vault,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: "registerEscrow", args: [escrow] }),
      },
      { env },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      log(`job ${job.id}: registerEscrow tx ${hash} FAILED onchain — leaving it for the next run.`);
      continue;
    }
    actions += 1;
    registered += 1;
    log(`job ${job.id}: escrow registered — tx ${hash}`);
  }

  // Pass 2 — seal: delivered jobs with a FUNDED escrow and no seal
  // recorded yet. The hash comes from the stored report, through the
  // same helper the server uses.
  for (const job of jobs) {
    if (actions >= MAX_ACTIONS_PER_RUN) break;
    if (job.status !== "delivered" || !job.escrowAddress || job.deliverableTxHash) continue;
    const escrow = job.escrowAddress as Address;
    let onchain;
    try {
      onchain = await readEscrowOnchain(escrow, { rpcUrl: config.rpcUrl });
    } catch (err) {
      log(`job ${job.id}: could not read escrow ${escrow} onchain — skipping. (${err instanceof Error ? err.message : "unknown error"})`);
      continue;
    }
    if (!onchain.exists || onchain.state !== 1) {
      log(`job ${job.id}: escrow is not FUNDED onchain (state ${onchain.state}) — skipping.`);
      continue;
    }
    // The seal goes to the escrow's own vault — a cNGN escrow seals in
    // the cNGN vault, never the USDT one.
    const vault = onchain.vault as Address | null;
    if (!vault) {
      log(`job ${job.id}: escrow ${escrow} names no vault onchain — skipping.`);
      continue;
    }
    const detailRes = await fetchJson(`${config.siteUrl}/api/jobs/${job.id}`);
    if (detailRes.status !== 200) {
      log(`job ${job.id}: could not fetch the job detail (HTTP ${detailRes.status}) — skipping.`);
      continue;
    }
    const report = detailRes.body.report as { report?: string; html?: string; slides?: { title: string; text: string }[]; status?: string } | null;
    if (!report || report.status !== "delivered") {
      log(`job ${job.id}: no delivered report on the site yet — skipping.`);
      continue;
    }
    const content = reportToDeliverableContent(report);
    if (!content) {
      log(`job ${job.id}: delivered report carries no content to seal — skipping.`);
      continue;
    }
    const hash = deliverableHashFor(content);
    // Already sealed onchain but never recorded: the seal tx hash is
    // unknown, so the route can't verify it — say so and move on
    // rather than sending a second submitDeliverable that must revert.
    const sealedOnchain = await publicClient.readContract({
      address: escrow,
      abi: ESCROW_READ_ABI,
      functionName: "deliverableHash",
    });
    if (sealedOnchain !== ZERO_HASH) {
      if (sealedOnchain.toLowerCase() === hash.toLowerCase()) {
        log(`job ${job.id}: deliverable already sealed onchain (${sealedOnchain}) but no seal tx recorded — the tx hash is unknown, so it cannot be recorded. Skipping.`);
      } else {
        log(`job ${job.id}: escrow already sealed with a DIFFERENT hash (${sealedOnchain} vs ${hash}) — refusing to overwrite. Skipping.`);
      }
      continue;
    }
    log(`job ${job.id}: sealing deliverable ${hash} on escrow ${escrow}…`);
    const { hash: txHash } = await sendTagged(
      walletClient,
      {
        to: vault,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: "submitDeliverable", args: [escrow, hash] }),
      },
      { env },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      log(`job ${job.id}: submitDeliverable tx ${txHash} FAILED onchain — leaving it for the next run.`);
      continue;
    }
    actions += 1;
    sealed += 1;
    log(`job ${job.id}: deliverable sealed — tx ${txHash}`);
    const recordRes = await fetchJson(`${config.siteUrl}/api/jobs/${job.id}/deliverable`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    });
    if (recordRes.status !== 200) {
      log(`job ${job.id}: seal is onchain (${txHash}) but recording it failed (HTTP ${recordRes.status}: ${JSON.stringify(recordRes.body.error ?? recordRes.body)}) — the next run will see it sealed and skip it; record the tx by hand if needed.`);
    } else {
      log(`job ${job.id}: seal recorded on the site.`);
    }
  }

  // Pass 3 — naira bills (mainnet only: there is no Celo testnet
  // corridor). The pipeline lives in ./bills.ts; this is only the wiring
  // of real clients around it. A failure here never breaks the job work
  // above — the bills wait for the next run.
  let billsChecked = 0;
  let billsConverted = 0;
  let billsPaid = 0;
  if (config.chain !== "mainnet") {
    log("naira bills run on mainnet only — skipping the bill pass.");
  } else {
    try {
      const billsRes = await fetchJson(`${config.siteUrl}/api/bills`);
      if (billsRes.status === 404) {
        // The bills code ships before the site redeploys: the route does
        // not exist yet. Skip quietly instead of failing the run.
        log("the site doesn't serve /api/bills yet — skipping the bill pass.");
      } else if (billsRes.status !== 200 || !Array.isArray(billsRes.body.bills)) {
        log(`could not list bills from ${config.siteUrl}/api/bills (HTTP ${billsRes.status}) — skipping the bill pass.`);
      } else {
        const bills = billsRes.body.bills as SiteBill[];
        log(`${bills.length} bill(s) on the site.`);
        const textile = new TextileClient();
        const signer: TakerSigner = {
          address: account.address,
          signTypedData: (args) => account.signTypedData(args),
        };
        const billRuntime: BillRuntime = {
          takerAddress: account.address,
          preview: (buyAmount) =>
            textile.previewQuote({
              chainId: config.chainId,
              sellToken: config.tokenAddress,
              buyToken: CNGN_ADDRESS,
              buyAmount,
            }),
          firmQuote: (buyAmount) =>
            textile.requestFirmQuote(
              {
                chainId: config.chainId,
                sellToken: config.tokenAddress,
                buyToken: CNGN_ADDRESS,
                buyAmount,
                taker: account.address,
              },
              { signer },
            ),
          cancelQuote: (rfqId, claimToken) => textile.cancelQuote(rfqId, claimToken).then(() => undefined),
          usdtBalanceOf: (owner) =>
            publicClient.readContract({
              address: config.tokenAddress,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner as Address],
            }),
          cngnBalanceOf: (owner) =>
            publicClient.readContract({
              address: CNGN_ADDRESS,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner as Address],
            }),
          celoBalanceOf: (owner) => publicClient.getBalance({ address: owner as Address }),
          codeAt: (address) => publicClient.getCode({ address: address as Address }),
          getAllowance: (token, owner, spender) =>
            publicClient.readContract({
              address: token as Address,
              abi: erc20Abi,
              functionName: "allowance",
              args: [owner as Address, spender as Address],
            }),
          waitForReceipt: (hash) =>
            publicClient.waitForTransactionReceipt({ hash: hash as Hex }).then((r) => ({ status: r.status })),
          getReceipt: (hash) =>
            publicClient
              .getTransactionReceipt({ hash: hash as Hex })
              .then((r) => ({ status: r.status }))
              .catch(() => null),
          executeSwap: (quote, sendFn, opts) => textile.executeSwap(quote, sendFn, opts),
          sendTagged: async (tx) =>
            (
              await sendTagged(
                walletClient,
                {
                  to: tx.to as Address,
                  data: tx.data as Hex,
                  ...(tx.value && tx.value !== "0" ? { value: BigInt(tx.value) } : {}),
                },
                { env },
              )
            ).hash,
          sendRaw: async (tx) =>
            walletClient.sendTransaction({
              account,
              chain: viemChain,
              to: tx.to as Address,
              data: tx.data as Hex,
              ...(tx.value && tx.value !== "0" ? { value: BigInt(tx.value) } : {}),
            }),
          updateBill: async (id, update) => {
            const res = await fetchJson(`${config.siteUrl}/api/bills/${id}/update`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(update),
            });
            if (res.status !== 200) {
              throw new Error(
                `POST /api/bills/${id}/update failed (HTTP ${res.status}: ${JSON.stringify(res.body.error ?? res.body)})`,
              );
            }
          },
          nowIso: () => new Date().toISOString(),
          log: (msg) => log(msg),
        };
        const billResult = await processBills(bills, billRuntime, MAX_ACTIONS_PER_RUN - actions);
        actions += billResult.actionsUsed;
        billsChecked = billResult.checked;
        billsConverted = billResult.converted;
        billsPaid = billResult.paid;
        log(
          `bills: ${billResult.checked} checked, ${billResult.converted} converted, ${billResult.paid} paid, ${billResult.refused} refused, ${billResult.waiting} waiting, ${billResult.failed} failed.`,
        );
      }
    } catch (err) {
      log(`bill pass failed (${err instanceof Error ? err.message : "unknown error"}) — the job work above still stands; the next run retries the bills.`);
    }
  }

  log(`done — ${registered} escrow(s) registered, ${sealed} deliverable(s) sealed, ${billsChecked} bill(s) checked, ${billsConverted} converted, ${billsPaid} paid, ${actions} action(s).`);
  return { registered, sealed, billsChecked, billsConverted, billsPaid };
}

if (process.argv[1]?.endsWith("boss-worker.js")) {
  runBossWorker()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err: unknown) => {
      console.error(`[boss] FAILED — ${err instanceof Error ? err.message : "unknown error"}`);
      process.exitCode = 1;
    });
}
