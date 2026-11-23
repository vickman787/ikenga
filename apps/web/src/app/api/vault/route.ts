import { NextResponse } from "next/server";
import { getChainConfig, readVaultOnchain } from "@/lib/jobs";

/**
 * GET /api/vault — IkengaVault's four pots, read straight from the chain,
 * plus the token the vault holds. All amounts are atomic units (6 decimals)
 * as strings, so no precision is lost in JSON. Read-only: no key, no
 * signing, no money moves. The landing page reads this so the vault panel
 * shows the real pots instead of a hardcoded 0.00.
 *
 * { chainId, vaultAddress, tokenSymbol, tokenBalance, buckets: {
 *   operating, tools, bond, reserve } }
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
  let onchain;
  try {
    onchain = await readVaultOnchain(config.vaultAddress, config.tokenAddress);
  } catch (err) {
    return NextResponse.json(
      { error: `Could not read the vault onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})` },
      { status: 502 },
    );
  }
  if (!onchain.exists || !onchain.buckets) {
    return NextResponse.json(
      { error: "The vault is not on the chain yet at that address." },
      { status: 502 },
    );
  }
  return NextResponse.json({
    chainId: config.chainId,
    vaultAddress: config.vaultAddress,
    tokenSymbol: config.tokenSymbol,
    tokenBalance: (onchain.tokenBalance ?? 0n).toString(),
    buckets: {
      operating: onchain.buckets.operating.toString(),
      tools: onchain.buckets.tools.toString(),
      bond: onchain.buckets.bond.toString(),
      reserve: onchain.buckets.reserve.toString(),
    },
  });
}
