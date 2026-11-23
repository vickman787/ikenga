/**
 * Multi-token escrow proof on Celo Sepolia — the cNGN path, with test
 * USDC standing in for the second currency.
 *
 * There is no cNGN on Sepolia and no testnet corridor, so a real cNGN
 * job cannot be run there. This script proves the same code path with
 * two tokens side by side: the real Sepolia vault (test USDC, the $1
 * job) stays untouched, and a second vault + a second token (a mintable
 * mock, standing in for cNGN) run a job at a cNGN-like price —
 * 1,445,000,000 atomic units, the fixed price of a $1 job at
 * ~1,445 cNGN per $1.
 *
 * Run:  IKENGA_LIVE_TESTS=1 pnpm --filter @ikenga/agent exec:multitoken-sepolia
 *
 * Sepolia only — it never touches mainnet. The customer steps use the
 * exact browser sequence (encode -> tag -> sendTransaction), and every
 * customer transaction is read back and checked for the tag:
 *   1. deploy a mock second token + a second vault for it
 *   2. deploy a per-job escrow (token = mock, vault = second vault,
 *      price = 1,445,000,000) — tagged
 *   3. approve + fund exactly 1,445,000,000 — tagged
 *   4. boss: second vault registerEscrow + submitDeliverable
 *   5. customer accept() — tagged — the mock lands in the SECOND
 *      vault's OPERATING pot, the first vault untouched
 * Exits non-zero on the first failure.
 */
import { readFileSync } from "node:fs";
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
// A $1 job at ~1,445 cNGN per $1, in 6-decimal atomic units.
const CNGN_LIKE_PRICE = 1_445_000_000n;

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
  "function token() view returns (address)",
  "function ikengaVault() view returns (address)",
  "function deliverableHash() view returns (bytes32)",
]);

const vaultAbi = parseAbi([
  "constructor(address _boss, address _token)",
  "function registerEscrow(address escrow)",
  "function submitDeliverable(address escrow, bytes32 deliverableHash)",
  "function registeredEscrow(address escrow) view returns (bool)",
  "function boss() view returns (address)",
]);

const mockAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);

function artifact(name: string): { abi: never; bytecode: { object: Hex } } {
  return JSON.parse(
    readFileSync(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"),
  );
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
  const firstVault = (deployed.vault ?? deployed.IkengaVault) as Address;
  const firstToken = "0x01C5C0122039549AD1493B8220cABEdD739BC44E" as Address;
  if (!firstVault) fail("contracts", "no Sepolia vault in contracts/deployments/celo-sepolia.json");

  const pub = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
  const wallet = createWalletClient({ account, chain: celoSepolia, transport: http(RPC) });

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

  // The first vault must be untouched by this run — the cNGN-like job
  // pays into the second vault only.
  const firstVaultBefore = await readVaultOnchain(firstVault, firstToken, { rpcUrl: RPC });
  console.log(`start: first vault operating ${firstVaultBefore.buckets?.operating} atomic test USDC`);

  // 1. A second token (the cNGN stand-in) and a second vault for it.
  const mock = artifact("MockUSDT");
  const mockDeployTx = await wallet.deployContract({
    abi: mockAbi,
    bytecode: mock.bytecode.object as Hex,
    args: [],
    account,
    chain: celoSepolia,
  });
  const mockReceipt = await pub.waitForTransactionReceipt({ hash: mockDeployTx });
  const secondToken = mockReceipt.contractAddress;
  if (!secondToken) fail("mock-deploy", "no contract address in receipt");
  pass("mock-deploy", `second token ${secondToken} tx ${mockDeployTx}`);
  const mintTx = await wallet.writeContract({
    address: secondToken,
    abi: mockAbi,
    functionName: "mint",
    args: [customer, CNGN_LIKE_PRICE * 2n],
    account,
    chain: celoSepolia,
  });
  await pub.waitForTransactionReceipt({ hash: mintTx });
  const minted = await pub.readContract({ address: secondToken, abi: mockAbi, functionName: "balanceOf", args: [customer] });
  if (minted < CNGN_LIKE_PRICE) fail("mock-mint", `customer holds ${minted}, expected at least ${CNGN_LIKE_PRICE}`);
  pass("mock-mint", `customer holds ${minted} mock units`);

  const vaultArtifact = artifact("IkengaVault");
  const vaultDeployTx = await wallet.deployContract({
    abi: vaultAbi,
    bytecode: vaultArtifact.bytecode.object as Hex,
    args: [customer, secondToken],
    account,
    chain: celoSepolia,
  });
  const vaultReceipt = await pub.waitForTransactionReceipt({ hash: vaultDeployTx });
  const secondVault = vaultReceipt.contractAddress;
  if (!secondVault) fail("vault-deploy", "no contract address in receipt");
  const vaultBoss = await pub.readContract({ address: secondVault, abi: vaultAbi, functionName: "boss" });
  if (vaultBoss.toLowerCase() !== customer.toLowerCase()) {
    fail("vault-deploy", `second vault boss is ${vaultBoss}, expected ${customer}`);
  }
  pass("vault-deploy", `second vault ${secondVault} tx ${vaultDeployTx}, boss is the test wallet`);

  // 2. The escrow: token = second token, vault = second vault, price =
  // the cNGN-like fixed price — deployed the way the browser deploys it.
  const escrowArtifact = artifact("JobEscrow");
  const specHash = keccak256(toHex(`Ikenga multitoken e2e ${Date.now()}`));
  const deployData = encodeDeployData({
    abi: escrowAbi,
    bytecode: escrowArtifact.bytecode.object as Hex,
    args: [customer, secondVault, secondToken, 0n, CNGN_LIKE_PRICE, specHash],
  });
  const deployTx = await sendTagged("deploy", undefined, deployData);
  const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployTx });
  const escrow = deployReceipt.contractAddress;
  if (!escrow) fail("deploy", "no contract address in receipt");
  const onchain = {
    price: await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "price" }),
    token: await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "token" }),
    vault: await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "ikengaVault" }),
  };
  if (onchain.price !== CNGN_LIKE_PRICE) fail("deploy", `price()=${onchain.price}, expected ${CNGN_LIKE_PRICE}`);
  if (onchain.token.toLowerCase() !== secondToken.toLowerCase()) fail("deploy", `token()=${onchain.token}, expected ${secondToken}`);
  if (onchain.vault.toLowerCase() !== secondVault.toLowerCase()) fail("deploy", `ikengaVault()=${onchain.vault}, expected ${secondVault}`);
  pass("deploy", `escrow ${escrow}, price ${CNGN_LIKE_PRICE}, token + vault are the second pair`);

  // 3. Approve + fund exactly the cNGN-like price — tagged.
  await sendTagged(
    "approve",
    secondToken,
    encodeFunctionData({ abi: mockAbi, functionName: "approve", args: [escrow, CNGN_LIKE_PRICE] }),
  );
  await sendTagged(
    "fund",
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: "fund", args: [] }),
  );
  const stateAfterFund = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
  const escrowBal = await pub.readContract({ address: secondToken, abi: mockAbi, functionName: "balanceOf", args: [escrow] });
  if (Number(stateAfterFund) !== 1 || escrowBal !== CNGN_LIKE_PRICE) {
    fail("fund", `state=${stateAfterFund} escrowBal=${escrowBal}, expected state 1 and ${CNGN_LIKE_PRICE}`);
  }
  pass("fund", `escrow holds exactly ${CNGN_LIKE_PRICE} mock units`);

  // 4. Boss steps against the SECOND vault — this is what the boss
  // worker must do for a cNGN job: resolve the vault from the escrow.
  const regTx = await wallet.writeContract({
    address: secondVault, abi: vaultAbi, functionName: "registerEscrow", args: [escrow], account, chain: celoSepolia,
  });
  await pub.waitForTransactionReceipt({ hash: regTx });
  const registered = await pub.readContract({ address: secondVault, abi: vaultAbi, functionName: "registeredEscrow", args: [escrow] });
  if (!registered) fail("register", "second vault does not know the escrow after registerEscrow");
  pass("register", `register tx ${regTx} on the second vault`);

  const deliverableHash = keccak256(toHex(`delivered work, multitoken e2e ${Date.now()}`));
  const sealTx = await wallet.writeContract({
    address: secondVault, abi: vaultAbi, functionName: "submitDeliverable", args: [escrow, deliverableHash], account, chain: celoSepolia,
  });
  await pub.waitForTransactionReceipt({ hash: sealTx });
  const sealed = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "deliverableHash" });
  if (sealed !== deliverableHash) fail("seal", "deliverable hash not sealed on the escrow");
  pass("seal", `seal tx ${sealTx} on the second vault`);

  // 5. Accept — tagged. The mock must land in the SECOND vault's
  // OPERATING pot, and the first vault must not move at all.
  const secondVaultBefore = await readVaultOnchain(secondVault, secondToken, { rpcUrl: RPC });
  await sendTagged(
    "accept",
    escrow,
    encodeFunctionData({ abi: escrowAbi, functionName: "accept", args: [] }),
  );
  const state = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
  const secondVaultAfter = await readVaultOnchain(secondVault, secondToken, { rpcUrl: RPC });
  const firstVaultAfter = await readVaultOnchain(firstVault, firstToken, { rpcUrl: RPC });
  const operatingDelta = (secondVaultAfter.buckets?.operating ?? 0n) - (secondVaultBefore.buckets?.operating ?? 0n);
  if (Number(state) !== 2 || operatingDelta !== CNGN_LIKE_PRICE) {
    fail("accept", `state=${state} operatingDelta=${operatingDelta}, expected 2 and ${CNGN_LIKE_PRICE}`);
  }
  if (firstVaultAfter.buckets?.operating !== firstVaultBefore.buckets?.operating) {
    fail("accept", `first vault operating moved (${firstVaultBefore.buckets?.operating} -> ${firstVaultAfter.buckets?.operating}) — the two vaults must stay separate`);
  }
  pass("accept", `escrow ACCEPTED, second vault operating +${CNGN_LIKE_PRICE}, first vault untouched`);
  console.log(`end: second vault operating ${secondVaultAfter.buckets?.operating} atomic mock units`);
  console.log("Multi-token escrow e2e on Sepolia: ALL PASS");
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
