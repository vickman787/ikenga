import { NextResponse } from "next/server";
import { getChainConfig } from "@/lib/jobs";

/**
 * GET /api/chain — which chain this job's escrow lives on, and what it
 * pays with. The browser reads this before deploying the escrow, so the
 * escrow it deploys matches the vault and token the server will check.
 *
 * { chainId, chainName, vaultAddress, tokenAddress, tokenSymbol,
 *   priceAtomic: "1000000", bondAtomic: "0", explorerUrl }
 */
export async function GET() {
  try {
    return NextResponse.json(getChainConfig());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The chain is not set up on the server yet." },
      { status: 500 },
    );
  }
}
