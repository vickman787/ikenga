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
import { createPublicClient, erc20Abi, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";

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
    return { exists: false, customer: null, vault: null, token: null, state: null, tokenBalance: null };
  }
  const [customer, vault, token, state] = await Promise.all([
    client.readContract({ address, abi: ESCROW_ABI, functionName: "customer" }),
    client.readContract({ address, abi: ESCROW_ABI, functionName: "ikengaVault" }),
    client.readContract({ address, abi: ESCROW_ABI, functionName: "token" }),
    client.readContract({ address, abi: ESCROW_ABI, functionName: "state" }),
  ]);
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
  return { exists: true, customer, vault, token, state: Number(state), tokenBalance };
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
