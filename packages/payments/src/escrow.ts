/**
 * On-chain reads for a job's JobEscrow — the server never trusts a tx hash
 * or an address on its own word. Every escrow step (register, fund,
 * accept / reject) is checked against the chain first: the contract must
 * exist, belong to the right customer, point at Ikenga's vault and token,
 * and be in the state the step needs.
 *
 * Read-only: no key, no signing, no money moves here. The RPC comes from
 * CELO_RPC_URL / CELO_SEPOLIA_RPC_URL (Ankr defaults); which chain is
 * picked by IKENGA_CHAIN ("mainnet" default, "sepolia" for tests).
 */
import { createPublicClient, decodeFunctionData, erc20Abi, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { stripAttribution } from "./attribution.js";

export const CELO_MAINNET_RPC_URL = "https://rpc.ankr.com/celo";
export const CELO_SEPOLIA_RPC_URL_DEFAULT = "https://rpc.ankr.com/celo_sepolia";

/** "mainnet" unless IKENGA_CHAIN says "sepolia". Anything else is a mistake. */
export function escrowChain(): "mainnet" | "sepolia" {
  const chain = (process.env.IKENGA_CHAIN ?? "mainnet").toLowerCase();
  if (chain !== "mainnet" && chain !== "sepolia") {
    throw new Error(`IKENGA_CHAIN must be "mainnet" or "sepolia", got "${chain}".`);
  }
  return chain;
}

/** The RPC URL for the escrow chain (env override, Ankr default). */
export function escrowRpcUrl(): string {
  return escrowChain() === "sepolia"
    ? (process.env.CELO_SEPOLIA_RPC_URL ?? CELO_SEPOLIA_RPC_URL_DEFAULT)
    : (process.env.CELO_RPC_URL ?? CELO_MAINNET_RPC_URL);
}

/** A read-only client for the escrow chain. No `chain` argument (like
 * self.ts): a chain-specific client is not assignable to viem's generic
 * PublicClient, and the chain is not needed for these reads — the RPC
 * URL already picks the chain. */
export function createEscrowClient(opts?: { rpcUrl?: string }): PublicClient {
  return createPublicClient({ transport: http(opts?.rpcUrl ?? escrowRpcUrl()) });
}

const ESCROW_ABI = parseAbi([
  "function customer() view returns (address)",
  "function ikengaVault() view returns (address)",
  "function token() view returns (address)",
  "function state() view returns (uint8)",
  "function price() view returns (uint256)",
  "function deliverableHash() view returns (bytes32)",
]);

export interface EscrowOnchain {
  /** False when there is no contract code at the address. */
  exists: boolean;
  /** The wallet that deployed the escrow (the customer). Null when no contract. */
  customer: Address | null;
  /** The IkengaVault the escrow pays into. Null when no contract. */
  vault: Address | null;
  /** The token the escrow holds (USDT mainnet, test USDC Sepolia). Null when no contract. */
  token: Address | null;
  /** 0 UNFUNDED, 1 FUNDED, 2 ACCEPTED, 3 REJECTED, 4 RELEASED. Null when no contract. */
  state: number | null;
  /** The price fixed at deploy, in the token's atomic units. Null when no contract. */
  price: bigint | null;
  /** Token balance the escrow holds, in atomic units. Null when it can't be read. */
  tokenBalance: bigint | null;
}

export interface EscrowReadOptions {
  /** A client to use instead of one built from env (tests inject a mock). */
  client?: PublicClient;
  rpcUrl?: string;
}

/**
 * Read a JobEscrow's on-chain state. `exists` is false when there is no
 * contract at the address yet — every other field is null then, and the
 * caller should turn the job down in plain words rather than guess.
 */
export async function readEscrowOnchain(escrowAddress: string, opts?: EscrowReadOptions): Promise<EscrowOnchain> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrowAddress)) {
    throw new Error("That escrow address doesn't look like an address (0x… followed by 40 hex characters).");
  }
  const address = escrowAddress as Address;
  const client = opts?.client ?? createEscrowClient({ rpcUrl: opts?.rpcUrl });
  const code = await client.getCode({ address });
  if (!code || code === "0x") {
    return { exists: false, customer: null, vault: null, token: null, state: null, price: null, tokenBalance: null };
  }
  const [customer, vault, token, state] = await Promise.all([
    client.readContract({ address, abi: ESCROW_ABI, functionName: "customer" }),
    client.readContract({ address, abi: ESCROW_ABI, functionName: "ikengaVault" }),
    client.readContract({ address, abi: ESCROW_ABI, functionName: "token" }),
    client.readContract({ address, abi: ESCROW_ABI, functionName: "state" }),
  ]);
  // price() exists only on escrows deployed after the cNGN change
  // (2026-11-23). Older escrows — including the live $1 job's — revert
  // here; their price is the old constant 1,000,000, reported as null
  // so callers that need it can fall back to the job record.
  let price: bigint | null = null;
  try {
    price = await client.readContract({ address, abi: ESCROW_ABI, functionName: "price" });
  } catch {
    price = null;
  }
  let tokenBalance: bigint | null = null;
  try {
    tokenBalance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  } catch {
    // A token that can't be read is reported as an unreadable balance;
    // the caller (fund) treats that as "not proven funded".
    tokenBalance = null;
  }
  return { exists: true, customer, vault, token, state: Number(state), price, tokenBalance };
}

/**
 * Read a JobEscrow's sealed deliverable hash. Null when there is no
 * contract at the address, or the hash has not been sealed yet (0x0…0).
 * The boss worker seals it via the vault; the deliverable route checks
 * it here before recording the seal.
 */
export async function readEscrowDeliverableHash(
  escrowAddress: string,
  opts?: EscrowReadOptions,
): Promise<Hex | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrowAddress)) {
    throw new Error("That escrow address doesn't look like an address (0x… followed by 40 hex characters).");
  }
  const address = escrowAddress as Address;
  const client = opts?.client ?? createEscrowClient({ rpcUrl: opts?.rpcUrl });
  const code = await client.getCode({ address });
  if (!code || code === "0x") return null;
  const hash = await client.readContract({ address, abi: ESCROW_ABI, functionName: "deliverableHash" });
  const zero = `0x${"0".repeat(64)}` as Hex;
  return hash === zero ? null : hash;
}

export interface TxReceiptCheck {
  /** True only when the receipt exists and its status is success (1). */
  ok: boolean;
  /** Who sent the transaction. Null when there is no receipt. */
  from: Address | null;
  /** The contract the transaction called. Null when there is no receipt (or it created a contract). */
  to: Address | null;
}

export interface FundingTransferCheck {
  /** True only when the transaction is a successful USDT transfer of exactly the expected amount to the expected recipient, from the expected payer. */
  ok: boolean;
  /** Plain-words reason when not ok — "not onchain yet", "reverted", "wrong token", "wrong payer", "wrong recipient", "wrong amount", "not a transfer", or "could not read the transaction". */
  reason: string | null;
  /** Who sent the transaction. Null when it can't be read. */
  from: Address | null;
  /** The contract the transaction called. Null when it can't be read. */
  to: Address | null;
  /** The transfer() recipient. Null when the input isn't a transfer. */
  recipient: Address | null;
  /** The transfer() amount, in atomic units. Null when the input isn't a transfer. */
  amountAtomic: bigint | null;
}

/**
 * Verify a bill-funding payment onchain: a successful USDT transfer
 * from the payer's wallet to the agent wallet, for exactly the amount
 * the payer said they paid.
 *
 * The funding transfer carries Ikenga's attribution tag (the browser
 * tags it like every other customer transaction), so the tag suffix is
 * stripped before the input is decoded — a tagged transfer decodes to
 * the exact transfer(to, amount) underneath, and an untagged manual
 * transfer decodes the same way.
 *
 * A transaction that isn't onchain yet, or that reverted, is reported
 * as not-ok, never thrown — the caller turns it into a plain-words
 * 400. An RPC that can't be reached still throws, so the caller can
 * answer 502 instead.
 */
export async function verifyFundingTransfer(
  txHash: string,
  expected: { token: string; from: string; recipient: string; amountAtomic: bigint },
  opts?: EscrowReadOptions,
): Promise<FundingTransferCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("That transaction hash doesn't look right — it should start with 0x and be 66 characters.");
  }
  const client = opts?.client ?? createEscrowClient({ rpcUrl: opts?.rpcUrl });
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (err) {
    // viem throws TransactionNotFoundError when the receipt isn't there yet.
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { ok: false, reason: "not onchain yet", from: null, to: null, recipient: null, amountAtomic: null };
    }
    throw err;
  }
  if (!receipt) {
    return { ok: false, reason: "not onchain yet", from: null, to: null, recipient: null, amountAtomic: null };
  }
  if (receipt.status !== "success") {
    return { ok: false, reason: "reverted", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
  }
  if (receipt.to?.toLowerCase() !== expected.token.toLowerCase()) {
    return { ok: false, reason: "wrong token", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
  }
  if (receipt.from.toLowerCase() !== expected.from.toLowerCase()) {
    return { ok: false, reason: "wrong payer", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
  }
  let tx;
  try {
    tx = await client.getTransaction({ hash: txHash as `0x${string}` });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      return { ok: false, reason: "not onchain yet", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
    }
    throw err;
  }
  if (!tx) {
    return { ok: false, reason: "not onchain yet", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
  }
  let decoded;
  try {
    decoded = decodeFunctionData({
      abi: erc20Abi,
      data: stripAttribution(tx.input as Hex),
    });
  } catch {
    return { ok: false, reason: "not a transfer", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
  }
  if (decoded.functionName !== "transfer") {
    return { ok: false, reason: "not a transfer", from: receipt.from, to: receipt.to, recipient: null, amountAtomic: null };
  }
  const [recipient, amountAtomic] = decoded.args as [Address, bigint];
  if (recipient.toLowerCase() !== expected.recipient.toLowerCase()) {
    return { ok: false, reason: "wrong recipient", from: receipt.from, to: receipt.to, recipient, amountAtomic };
  }
  if (amountAtomic !== expected.amountAtomic) {
    return { ok: false, reason: "wrong amount", from: receipt.from, to: receipt.to, recipient, amountAtomic };
  }
  return { ok: true, reason: null, from: receipt.from, to: receipt.to, recipient, amountAtomic };
}

/**
 * Check a transaction's receipt: it must exist and have succeeded.
 * A missing or failed receipt is reported as not-ok, never thrown — the
 * caller turns it into a plain-words 400. An RPC that can't be reached
 * still throws, so the caller can answer 502 instead.
 */
export async function verifyTxReceipt(txHash: string, opts?: EscrowReadOptions): Promise<TxReceiptCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new Error("That transaction hash doesn't look right — it should start with 0x and be 66 characters.");
  }
  const client = opts?.client ?? createEscrowClient({ rpcUrl: opts?.rpcUrl });
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return { ok: false, from: null, to: null };
  }
  return { ok: receipt.status === "success", from: receipt.from, to: receipt.to };
}

const VAULT_ABI = parseAbi([
  "function bucketBalance(uint8 bucket) view returns (uint256)",
]);

export interface VaultOnchain {
  /** False when there is no contract code at the vault address. */
  exists: boolean;
  /** Each pot's balance, in atomic units (6 decimals). Null when unreadable. */
  buckets: { operating: bigint; tools: bigint; bond: bigint; reserve: bigint } | null;
  /** The token the vault actually holds, in atomic units. Null when unreadable. */
  tokenBalance: bigint | null;
}

/**
 * Read IkengaVault's four pots straight from the chain, plus the token
 * it holds. Bucket order is the contract's enum: OPERATING 0, TOOLS 1,
 * BOND 2, RESERVE 3. Read-only: no key, no signing, no money moves.
 */
export async function readVaultOnchain(
  vaultAddress: string,
  tokenAddress: string,
  opts?: EscrowReadOptions,
): Promise<VaultOnchain> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
    throw new Error("That vault address doesn't look like an address (0x… followed by 40 hex characters).");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    throw new Error("That token address doesn't look like an address (0x… followed by 40 hex characters).");
  }
  const vault = vaultAddress as Address;
  const token = tokenAddress as Address;
  const client = opts?.client ?? createEscrowClient({ rpcUrl: opts?.rpcUrl });
  const code = await client.getCode({ address: vault });
  if (!code || code === "0x") {
    return { exists: false, buckets: null, tokenBalance: null };
  }
  const [operating, tools, bond, reserve, tokenBalance] = await Promise.all([
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "bucketBalance", args: [0] }),
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "bucketBalance", args: [1] }),
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "bucketBalance", args: [2] }),
    client.readContract({ address: vault, abi: VAULT_ABI, functionName: "bucketBalance", args: [3] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  ]);
  return { exists: true, buckets: { operating, tools, bond, reserve }, tokenBalance };
}
