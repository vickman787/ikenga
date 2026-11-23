/**
 * Per-job escrow end-to-end proof on Celo Sepolia — the exact customer
 * flow the browser runs, driven here with the test wallet as the
 * customer (and as the vault boss, since it deployed the Sepolia vault).
 *
 * Run:  IKENGA_LIVE_TESTS=1 pnpm --filter @ikenga/agent exec:per-job-sepolia
 *
 * Sepolia only — it never touches mainnet. Steps, twice (once to accept,
 * once to reject):
 *   1. deploy a per-job JobEscrow (customer = test wallet, bond 0)
 *   2. approve 1 test USDC, then fund() — exactly 1,000,000 atomic
 *   3. boss: vault.registerEscrow(escrow), vault.submitDeliverable(escrow, hash)
 *   4a. customer accept() — the $1 lands in the vault, escrow ACCEPTED
 *   4b. (second escrow) customer reject() — the $1 comes back, escrow REJECTED
 * Every step is verified onchain with reads, not trusted from receipts.
 * Exits non-zero on the first failure.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { celoSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

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
  "function reject()",
  "function state() view returns (uint8)",
  "function customer() view returns (address)",
  "function token() view returns (address)",
  "function ikengaVault() view returns (address)",
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

  const startVaultBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const startCustomerBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [customer] });
  console.log(`start: vault ${startVaultBal} atomic, customer ${startCustomerBal} atomic`);

  async function runJob(label: string, acceptIt: boolean): Promise<void> {
    const specHash = keccak256(toHex(`Ikenga per-job e2e ${label} ${Date.now()}`));
    const deployTx = await wallet.deployContract({
      abi: escrowAbi,
      bytecode,
      args: [customer, vault, token, 0n, specHash],
      account,
      chain: celoSepolia,
    });
    const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployTx });
    const escrow = deployReceipt.contractAddress;
    if (!escrow) fail(`${label}:deploy`, "no contract address in receipt");
    pass(`${label}:deploy`, `escrow ${escrow} tx ${deployTx}`);

    const approveTx = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: "approve",
      args: [escrow, PRICE],
      account,
      chain: celoSepolia,
    });
    await pub.waitForTransactionReceipt({ hash: approveTx });

    const fundTx = await wallet.writeContract({
      address: escrow,
      abi: escrowAbi,
      functionName: "fund",
      account,
      chain: celoSepolia,
    });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    const stateAfterFund = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
    const escrowBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [escrow] });
    if (Number(stateAfterFund) !== 1 || escrowBal !== PRICE) {
      fail(`${label}:fund`, `state=${stateAfterFund} escrowBal=${escrowBal}, expected state 1 and ${PRICE}`);
    }
    pass(`${label}:fund`, `fund tx ${fundTx}, escrow holds exactly ${PRICE}`);

    // Boss steps: register the escrow, then seal the deliverable.
    const regTx = await wallet.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "registerEscrow",
      args: [escrow],
      account,
      chain: celoSepolia,
    });
    await pub.waitForTransactionReceipt({ hash: regTx });
    const registered = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "registeredEscrow", args: [escrow] });
    if (!registered) fail(`${label}:register`, "vault does not know the escrow after registerEscrow");
    pass(`${label}:register`, `register tx ${regTx}`);

    const deliverableHash = keccak256(toHex(`delivered work for ${label}`));
    const sealTx = await wallet.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "submitDeliverable",
      args: [escrow, deliverableHash],
      account,
      chain: celoSepolia,
    });
    await pub.waitForTransactionReceipt({ hash: sealTx });
    const sealed = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "deliverableHash" });
    if (sealed !== deliverableHash) fail(`${label}:seal`, "deliverable hash not sealed on the escrow");
    pass(`${label}:seal`, `seal tx ${sealTx}`);

    if (acceptIt) {
      const vaultBefore = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
      const acceptTx = await wallet.writeContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "accept",
        account,
        chain: celoSepolia,
      });
      await pub.waitForTransactionReceipt({ hash: acceptTx });
      const state = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
      const vaultAfter = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
      if (Number(state) !== 2 || vaultAfter - vaultBefore !== PRICE) {
        fail(`${label}:accept`, `state=${state} vaultDelta=${vaultAfter - vaultBefore}, expected 2 and ${PRICE}`);
      }
      pass(`${label}:accept`, `accept tx ${acceptTx}, vault +${PRICE}, escrow ACCEPTED`);
    } else {
      const customerBefore = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [customer] });
      const rejectTx = await wallet.writeContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "reject",
        account,
        chain: celoSepolia,
      });
      await pub.waitForTransactionReceipt({ hash: rejectTx });
      const state = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "state" });
      const customerAfter = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [customer] });
      if (Number(state) !== 3 || customerAfter - customerBefore !== PRICE) {
        fail(`${label}:reject`, `state=${state} refund=${customerAfter - customerBefore}, expected 3 and ${PRICE}`);
      }
      pass(`${label}:reject`, `reject tx ${rejectTx}, customer refunded ${PRICE}, escrow REJECTED`);
    }
  }

  await runJob("accept-job", true);
  await runJob("reject-job", false);

  const endVaultBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const endCustomerBal = await pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [customer] });
  console.log(`end: vault ${endVaultBal} atomic (net +${endVaultBal - startVaultBal}), customer ${endCustomerBal} atomic`);
  console.log("Per-job escrow e2e on Sepolia: ALL PASS");
}

main().catch((e) => {
  console.log(`FAIL unexpected — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
