/**
 * Ikenga tool sellers — pinned payees (plan §2.5).
 *
 * The agent pays for its own tools per call via x402. A seller is paid
 * ONLY if its payee address matches the pinned address in this registry.
 * A changed payee is refused and logged — never paid on trust.
 *
 * Step 2: the registry starts EMPTY. There are no real sellers configured
 * yet — a seller is added only when the user approves that tool, with its
 * real Celo payee address and per-call price cap. An empty registry means
 * no tool payment can happen, which is the safe default.
 *
 * Payee addresses below are examples of the SHAPE only and are NOT real
 * sellers — do not treat them as configured. (No example addresses are
 * listed here, precisely so nothing can be mistaken for a real payee.)
 */

export interface ToolSeller {
  /** Tool/service name, e.g. "market-data". */
  service: string;
  /** Pinned Celo payee address. Payments to any other address are refused. */
  payTo: string;
  /** Per-call price cap, in atomic units of the asset (6 decimals). */
  maxPriceAtomic: string;
  /** Asset the seller accepts: "USDT" | "USDC" | "cNGN". */
  asset: "USDT" | "USDC" | "cNGN";
  /** Network the seller is on. */
  network: "eip155:42220" | "eip155:11142220";
}

export class ToolRegistry {
  private sellers = new Map<string, ToolSeller>();

  register(seller: ToolSeller): void {
    if (!/^0x[0-9a-fA-F]{40}$/.test(seller.payTo)) throw new Error("payTo must be an EVM address");
    if (!/^\d+$/.test(seller.maxPriceAtomic)) throw new Error("maxPriceAtomic must be an integer string");
    this.sellers.set(seller.service, seller);
  }

  get(service: string): ToolSeller | undefined {
    return this.sellers.get(service);
  }

  /**
   * Check a proposed payment against the pinned registry.
   * Returns {ok:true} only when the service is registered, the payee
   * matches the pinned address, and the amount is within the cap.
   */
  checkPayment(service: string, payTo: string, amountAtomic: string): { ok: boolean; reason: string } {
    const seller = this.sellers.get(service);
    if (!seller) return { ok: false, reason: `No pinned seller for service "${service}" — payment refused.` };
    if (seller.payTo.toLowerCase() !== payTo.toLowerCase()) {
      return { ok: false, reason: `Payee ${payTo} does not match pinned payee ${seller.payTo} for "${service}" — payment refused and logged.` };
    }
    if (BigInt(amountAtomic) > BigInt(seller.maxPriceAtomic)) {
      return { ok: false, reason: `Amount ${amountAtomic} exceeds the per-call cap ${seller.maxPriceAtomic} for "${service}" — payment refused.` };
    }
    return { ok: true, reason: "Payee pinned and amount within cap." };
  }
}
