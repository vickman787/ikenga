/**
 * Buyer side of x402: the agent paying for its own tools (Step 2,
 * Workstream A, plan §2.1). Uses @x402/fetch + @x402/evm + viem — the
 * middleware signs EIP-3009 authorizations (or Permit2 transfers) and
 * retries with the payment header. Payloads are NEVER hand-built.
 *
 * Verified against the installed @x402 2.32.0:
 * - The retry header for x402 v2 is PAYMENT-SIGNATURE. X-PAYMENT is the
 *   v1 header (see encodePaymentSignatureHeader in @x402/core). The plan's
 *   UNVERIFIED item (a) resolves in favour of the Celo docs — trust
 *   PAYMENT-SIGNATURE for v2. The middleware sends the right one per
 *   version; nothing here sets a header by hand.
 * - Spend controls MUST be set via client.setSpendControls(...) — the
 *   x402Client constructor takes only a requirements selector. The default
 *   cap is "$1" per payment (DEFAULT_MAX_AMOUNT_PER_PAYMENT). Passing
 *   spendControls:false is refused here, always.
 * - Permit2 assets are opt-in via spendControls.allowedAssets (a list of
 *   { network, asset, maxAmountPerPayment? }). Default assets (USDC/USDT/
 *   USAT on mainnet, USDC on Sepolia) are allowed without opt-in.
 * - ExactEvmScheme needs an RPC url only to backfill chain reads the
 *   signer cannot do itself (allowance/nonces for sponsored Permit2
 *   permits). Forno is rate-limited, best-effort, no SLA.
 *
 * The signer is a viem account (privateKeyToAccount) for plain EIP-3009
 * flows. For gas-sponsored Permit2 payments use toBuyerSigner(account,
 * publicClient) so the scheme can read allowance/nonces; without it, a
 * wallet with no Permit2 allowance gets 412 permit2_allowance_required.
 *
 * No private key is ever read here — the caller owns the signer. No API
 * key is involved on the buyer side (only the facilitator's /settle needs
 * one, server side).
 */
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import type { SpendControlAsset, SpendControls } from "@x402/core/client";
import type { Network } from "@x402/core/types";

export type { ClientEvmSigner, SpendControlAsset, SpendControls };

/** x402 v2 retry header (v1 used X-PAYMENT). Set by the middleware, never by hand. */
export const PAYMENT_RETRY_HEADER_V2 = "PAYMENT-SIGNATURE";
export const PAYMENT_RETRY_HEADER_V1 = "X-PAYMENT";

export const CELO_RPC_URL = "https://forno.celo.org";
export const CELO_SEPOLIA_RPC_URL = "https://forno.celo-sepolia.celo-testnet.org";
/** Default per-payment cap (the @x402 default). */
export const X402_BUYER_DEFAULT_SPEND_CAP = "$1";

const CELO_NETWORKS = ["eip155:42220", "eip155:11142220"] as const;
type CeloNetwork = (typeof CELO_NETWORKS)[number];

function defaultRpcUrl(network: CeloNetwork): string {
  return network === "eip155:11142220" ? CELO_SEPOLIA_RPC_URL : CELO_RPC_URL;
}

/**
 * Wrap a viem account (or any ClientEvmSigner) with a public client so the
 * scheme can do the chain reads gas-sponsored Permit2 payments need.
 * Plain EIP-3009 flows can pass the account directly as the signer.
 */
export function toBuyerSigner(
  signer: Parameters<typeof toClientEvmSigner>[0],
  publicClient?: Parameters<typeof toClientEvmSigner>[1],
): ClientEvmSigner {
  return toClientEvmSigner(signer, publicClient);
}

export interface BuyerClientOptions {
  /** EVM signer (viem account, or toBuyerSigner(...) for Permit2 sponsoring). */
  signer: ClientEvmSigner;
  network?: string;
  /** JSON-RPC endpoint for chain reads. Defaults to Forno by network. */
  rpcUrl?: string;
  /**
   * Spend controls. Defaults to { maxAmountPerPayment: "$1" }.
   * `false` is REFUSED — spend controls are never disabled.
   * Opt in to Permit2 assets via allowedAssets (see X402_SUPPORTED_ASSETS).
   */
  spendControls?: SpendControls;
}

function validateSpendControls(controls: SpendControls): void {
  if (controls.allowedAssets !== undefined && controls.allowedAssets !== true) {
    for (const entry of controls.allowedAssets) {
      if (!entry.network || !entry.asset) {
        throw new Error("spendControls.allowedAssets entries need { network, asset }.");
      }
      if (
        entry.maxAmountPerPayment !== undefined &&
        !/^\d+$/.test(entry.maxAmountPerPayment)
      ) {
        throw new Error(
          `spendControls.allowedAssets maxAmountPerPayment must be an atomic-unit integer string, got ${JSON.stringify(entry.maxAmountPerPayment)}.`,
        );
      }
    }
  }
  if (
    controls.maxAmountPerPayment !== undefined &&
    controls.maxAmountPerPayment !== false &&
    typeof controls.maxAmountPerPayment !== "string" &&
    typeof controls.maxAmountPerPayment !== "number"
  ) {
    throw new Error("spendControls.maxAmountPerPayment must be a Money string like \"$1\".");
  }
}

/**
 * Build a buyer client for a Celo network. Spend controls are applied via
 * setSpendControls(...) (method call, never the constructor) and default
 * to a $1 per-payment cap on default assets only. The client enforces the
 * controls in createPaymentPayload — an over-cap payment is rejected
 * BEFORE any signing happens.
 */
export function createBuyerClient(opts: BuyerClientOptions): x402Client {
  const network = (opts.network ?? "eip155:42220") as CeloNetwork;
  if (!CELO_NETWORKS.includes(network)) {
    throw new Error(
      `Unsupported buyer network ${JSON.stringify(network)}: expected eip155:42220 or eip155:11142220.`,
    );
  }
  if ((opts as { spendControls?: unknown }).spendControls === false) {
    throw new Error(
      "spendControls:false is never allowed: Ikenga agents always pay under a per-payment cap.",
    );
  }
  const controls: SpendControls = opts.spendControls ?? {
    maxAmountPerPayment: X402_BUYER_DEFAULT_SPEND_CAP,
  };
  if (controls.maxAmountPerPayment === false) {
    throw new Error(
      "spendControls.maxAmountPerPayment:false is never allowed: the per-payment cap must stay on.",
    );
  }
  validateSpendControls(controls);
  const rpcUrl = opts.rpcUrl ?? defaultRpcUrl(network);
  return new x402Client()
    .register(
      network as Network,
      new ExactEvmScheme(opts.signer, { rpcUrl }),
    )
    .setSpendControls(controls);
}

/**
 * Wrap a fetch implementation so 402 responses are paid automatically and
 * retried with the payment header (PAYMENT-SIGNATURE for v2). Defaults to
 * the global fetch. The wrapped fetch is what the agent uses to call paid
 * tool routes.
 */
export function createPaymentFetch(
  client: x402Client,
  fetchFn: typeof fetch = globalThis.fetch,
): typeof fetch {
  return wrapFetchWithPayment(fetchFn, client);
}
