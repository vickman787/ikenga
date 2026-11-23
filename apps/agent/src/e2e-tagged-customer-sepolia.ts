/**
 * Tagged customer-flow proof on Celo Sepolia — the exact call sequence
 * the browser now runs (apps/web/src/lib/contracts.ts), driven here with
 * the test wallet as the customer:
 *
 *   encodeDeployData / encodeFunctionData
 *     -> appendAttribution(data, tag)   (the tag the server hands the browser)
 *     -> wallet.sendTransaction({ data: tagged })
 *
 * Run:  IKENGA_LIVE_TESTS=1 pnpm --filter @ikenga/agent exec:tagged-sepolia
 *
 * Sepolia only — it never touches mainnet. One job, accept path:
 *   1. deploy a per-job JobEscrow (tagged)
 *   2. approve 1 test USDC (tagged), then fund() (tagged) — exactly 1,000,000 atomic
 *   3. boss: vault.registerEscrow(escrow), vault.submitDeliverable(escrow, hash)
 *   4. customer accept() (tagged) — the $1 lands in the vault, escrow ACCEPTED
 * Every customer transaction's input is read back from the chain and
 * checked for the tag with parseAttribution — the tag must be there, and
 * the call itself must still do exactly what it did untagged.
 * Exits non-zero on the first failure.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
import { appendAttribution, parseAttribution, readVaultOnchain } from "@ikenga/payments";

const RPC = process.env.CELO_SEPOLIA_RPC_URL ?? "https://rpc.ankr.com/celo_sepolia";
const PRICE = 1_000_000n;

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
  "constructor(address customer, address vault, address token, uint256 bondAmount, bytes32 specHash)",
  "function fund()",
  "function accept()",
  "function state() view returns (uint8)",
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

  /** Send one tagged call exactly the way the browser does, then read the
   * transaction back from the chain and prove the tag is on it. */
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

  // readVaultOnchain defaults to the mainnet RPC — this script is Sepolia,
  // so the Sepolia RPC must be passed explicitly, or it reads an address
  // with no code on mainnet and reports no buckets.
  const vaultBefore = await readVaultOnchain(vault, token, { rpcUrl: RPC });
  console.log(`start: vault operating ${vaultBefore.buckets?.operating} atomic`);

  // 1. Deploy the escrow — tagged.
  const specHash = keccak256(toHex(`Ikenga tagged e2e ${Date.now()}`));
  const deployData = encodeDeployData({
    abi: escrowAbi,
    bytecode,
    args: [customer, vault, token, 0n, specHash],
  });
  const deployTx = await sendTagged("deploy", undefined, deployData);
  const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployTx });
  const escrow = deployReceipt.contractAddress;
  if (!escrow) fail("deploy", "no contract address in receipt");
  pass("deploy", `escrow ${escrow}`);

  // 2. Approve + fund — tagged.
  await sendTagged(
    "approve",
    token,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [escrow, PRICE] }),
  );
  await sendTagged(
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

  // 3. Boss steps (already tagged in production via sendTagged; here the
  // test wallet acts as boss, as in the untagged e2e).
  const regTx = await wallet.writeContract({
    address: vault, abi: vaultAbi, functionName: "registerEscrow", args: [escrow], account, chain: celoSepolia,
  });
  await pub.waitForTransactionReceipt({ hash: regTx });
  const registered = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "registeredEscrow", args: [escrow] });
  if (!registered) fail("register", "vault does not know the escrow after registerEscrow");
  pass("register", `register tx ${regTx}`);

  const deliverableHash = keccak256(toHex(`delivered work, tagged e2e ${Date.now()}`));
  const sealTx = await wallet.writeContract({
    address: vault, abi: vaultAbi, functionName: "submitDeliverable", args: [escrow, deliverableHash], account, chain: celoSepolia,
  });
  await pub.waitForTransactionReceipt({ hash: sealTx });
  const sealed = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "deliverableHash" });
  if (sealed !== deliverableHash) fail("seal", "deliverable hash not sealed on the escrow");
  pass("seal", `seal tx ${sealTx}`);

  // 4. Accept — tagged. The $1 must land in the vault's OPERATING pot.
  await sendTagged(
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
  console.log(`end: vault operating ${vaultAfter.buckets?.operating} atomic`);
  console.log("Tagged customer-flow e2e on Sepolia: ALL PASS");
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
