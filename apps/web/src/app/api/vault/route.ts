import { NextResponse } from "next/server";
import { getChainConfig, readVaultOnchain } from "@/lib/jobs";

/**
 * GET /api/vault — the vaults' four pots, read straight from the chain.
 * All amounts are atomic units (6 decimals) as strings, so no precision
 * is lost in JSON. Read-only: no key, no signing, no money moves. The
 * landing page reads this so the vault panel shows the real pots
 * instead of a hardcoded 0.00.
 *
 * Ikenga keeps one vault per currency — USDT and cNGN are never mixed
 * and never silently converted. The top-level fields are the USDT vault
 * (the landing already reads them); `vaults` lists every vault, with
 * the cNGN slot honest — `vaultAddress: null` and zero balances —
 * until the cNGN vault is deployed.
 *
 * { chainId, vaultAddress, tokenSymbol, tokenBalance, buckets: {
 *   operating, tools, bond, reserve }, vaults: [{ currency,
 *   vaultAddress, tokenAddress, tokenSymbol, tokenBalance, buckets }] }
 */
export async function GET() {
  let config;
  try {
    config = getChainConfig();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The chain is not set up on the server yet." },
      { status: 500 },
    );
  }
  const vaults: {
    currency: string;
    vaultAddress: string | null;
    tokenAddress: string;
    tokenSymbol: string;
    tokenBalance: string;
    buckets: { operating: string; tools: string; bond: string; reserve: string };
  }[] = [];
  try {
    for (const currency of config.payTokens) {
      const vaultAddress = config.vaults[currency] ?? null;
      const tokenAddress = config.tokens[currency]!;
      if (!vaultAddress) {
        // Not deployed yet — report the slot honestly, never hide it.
        vaults.push({
          currency,
          vaultAddress: null,
          tokenAddress,
          tokenSymbol: currency,
          tokenBalance: "0",
          buckets: { operating: "0", tools: "0", bond: "0", reserve: "0" },
        });
        continue;
      }
      const onchain = await readVaultOnchain(vaultAddress, tokenAddress);
      if (!onchain.exists || !onchain.buckets) {
        return NextResponse.json(
          { error: `The ${currency} vault is not on the chain yet at that address.` },
          { status: 502 },
        );
      }
      vaults.push({
        currency,
        vaultAddress,
        tokenAddress,
        tokenSymbol: currency,
        tokenBalance: (onchain.tokenBalance ?? 0n).toString(),
        buckets: {
          operating: onchain.buckets.operating.toString(),
          tools: onchain.buckets.tools.toString(),
          bond: onchain.buckets.bond.toString(),
          reserve: onchain.buckets.reserve.toString(),
        },
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read the vault onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})` },
      { status: 502 },
    );
  }
  const usdt = vaults.find((v) => v.currency === "USDT") ?? vaults[0]!;
  return NextResponse.json({
    chainId: config.chainId,
    vaultAddress: usdt.vaultAddress,
    tokenAddress: usdt.tokenAddress,
    tokenSymbol: usdt.tokenSymbol,
    tokenBalance: usdt.tokenBalance,
    buckets: usdt.buckets,
    vaults,
  });
}
