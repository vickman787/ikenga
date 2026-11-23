/**
 * Investigator — the checks that run before any money moves.
 *
 * Investigator never moves money and never touches a model. It only
 * reads the chain and compares what it finds with the job or bill
 * record. Every check it runs is listed here, in plain words, and
 * nothing else is claimed:
 *   - a wallet is a real address (right shape, not the zero address);
 *   - the job's escrow is a real contract, and its customer, token,
 *     vault, price and funded state match the job record;
 *   - the supplier of a naira bill is a real address, not the zero
 *     address and not the agent wallet itself;
 *   - the payout amount is exactly the bill's amount;
 *   - the token and the swap contracts are real contracts on Celo
 *     (they have code onchain).
 *
 * What Investigator does NOT do: there is no sanctions, KYC or OFAC
 * check here — we have no such check, and the team page says so.
 * A bill or job that fails a check stops with a plain-words reason
 * and no money moves. A check that cannot be read (the chain is
 * unreachable) is reported as unreadable, not as a pass and not as
 * a fail — the caller decides whether to wait and try again.
 */
import { decodeFunctionData, erc20Abi, isAddress, zeroAddress } from "viem";
import type { EscrowOnchain } from "@ikenga/payments";

export interface InvestigatorCheck {
  /** Short name, for the log ("escrow customer", "supplier wallet"). */
  name: string;
  result: "passed" | "failed" | "skipped";
  /** Plain words — what was checked and what was found. */
  detail: string;
}

export interface InvestigatorResult {
  /** True only when every check that could run passed. */
  passed: boolean;
  /** False when the chain could not be read at all — not a pass, not a fail. */
  readable: boolean;
  checks: InvestigatorCheck[];
  /** One plain-words line for the log. */
  summary: string;
}

function passed(name: string, detail: string): InvestigatorCheck {
  return { name, result: "passed", detail };
}

function failed(name: string, detail: string): InvestigatorCheck {
  return { name, result: "failed", detail };
}

function skipped(name: string, detail: string): InvestigatorCheck {
  return { name, result: "skipped", detail };
}

function summarize(what: string, checks: InvestigatorCheck[]): string {
  const failedChecks = checks.filter((c) => c.result === "failed");
  if (failedChecks.length > 0) {
    return `Investigator stopped the ${what}: ${failedChecks[0].detail}`;
  }
  const passedCount = checks.filter((c) => c.result === "passed").length;
  const skippedCount = checks.filter((c) => c.result === "skipped").length;
  const skippedNote = skippedCount > 0 ? ` (${skippedCount} could not be read onchain, so ${skippedCount === 1 ? "it was" : "they were"} skipped)` : "";
  return `Investigator checked the ${what}: ${passedCount} ${passedCount === 1 ? "check" : "checks"} passed${skippedNote}.`;
}

export interface InvestigateJobEscrowInput {
  customerWallet: string;
  escrowAddress: string;
  tokenAddress: string;
  vaultAddress: string;
  /** The price fixed at hire, in the token's atomic units (6 decimals). */
  priceAtomic: string;
}

export interface InvestigateJobEscrowDeps {
  readEscrow: (address: string) => Promise<EscrowOnchain>;
}

/**
 * Check a job's escrow onchain before the team starts the work.
 * The escrow must be a real contract, its customer / token / vault /
 * price must match the job record, and the $1 must already be in it.
 */
export async function investigateJobEscrow(
  input: InvestigateJobEscrowInput,
  deps: InvestigateJobEscrowDeps,
): Promise<InvestigatorResult> {
  const checks: InvestigatorCheck[] = [];
  const finish = (readable: boolean): InvestigatorResult => {
    const passedAll = checks.every((c) => c.result !== "failed");
    return { passed: readable && passedAll, readable, checks, summary: summarize("escrow", checks) };
  };

  if (!isAddress(input.customerWallet) || input.customerWallet.toLowerCase() === zeroAddress) {
    checks.push(failed("customer wallet", "The customer's wallet is not a real wallet address, so the team cannot start this job."));
    return finish(true);
  }
  checks.push(passed("customer wallet", "The customer's wallet is a real address."));
  if (!isAddress(input.escrowAddress)) {
    checks.push(failed("escrow address", "The escrow address is not a real address, so the team cannot start this job."));
    return finish(true);
  }
  checks.push(passed("escrow address", "The escrow address is a real address."));

  let onchain: EscrowOnchain;
  try {
    onchain = await deps.readEscrow(input.escrowAddress);
  } catch (err) {
    return {
      passed: false,
      readable: false,
      checks: [failed("escrow read", `Could not read the escrow onchain right now — try again in a moment. (${err instanceof Error ? err.message : "unknown error"})`)],
      summary: "Investigator could not read the escrow onchain right now — the team waits.",
    };
  }
  if (!onchain.exists) {
    checks.push(failed("escrow contract", "There is no contract at the escrow address — the team cannot start a job with no escrow onchain."));
    return finish(true);
  }
  checks.push(passed("escrow contract", "The escrow is a real contract on Celo."));
  if ((onchain.customer ?? "").toLowerCase() !== input.customerWallet.toLowerCase()) {
    checks.push(failed("escrow customer", "The escrow onchain belongs to a different wallet than the customer who hired this job."));
  } else {
    checks.push(passed("escrow customer", "The escrow onchain belongs to the customer who hired this job."));
  }
  if ((onchain.token ?? "").toLowerCase() !== input.tokenAddress.toLowerCase()) {
    checks.push(failed("escrow token", "The escrow onchain holds a different token than this job was priced in."));
  } else {
    checks.push(passed("escrow token", "The escrow onchain holds the token this job was priced in."));
  }
  if ((onchain.vault ?? "").toLowerCase() !== input.vaultAddress.toLowerCase()) {
    checks.push(failed("escrow vault", "The escrow onchain pays into a different vault than this job's vault."));
  } else {
    checks.push(passed("escrow vault", "The escrow onchain pays into this job's vault."));
  }
  if (onchain.price == null) {
    // Escrows deployed before the cNGN change (2026-11-23) have no
    // price() to read — their $1 was already checked when it was funded.
    // (== null, so a missing price is skipped, never failed.)
    checks.push(skipped("escrow price", "This escrow was deployed before its price could be read onchain — the $1 in it was already checked when it was funded."));
  } else if (onchain.price !== BigInt(input.priceAtomic)) {
    checks.push(failed("escrow price", "The price fixed in the escrow onchain is not the price this job was hired at."));
  } else {
    checks.push(passed("escrow price", "The price fixed in the escrow onchain is the price this job was hired at."));
  }
  if (onchain.state == null) {
    checks.push(failed("escrow state", "The escrow's state could not be read onchain."));
  } else if (onchain.state !== 1) {
    checks.push(
      failed(
        "escrow state",
        onchain.state === 0
          ? "The escrow onchain is not funded yet — the $1 is not in it."
          : "The escrow onchain is already decided — it is not waiting for the team to start.",
      ),
    );
  } else {
    checks.push(passed("escrow state", "The escrow onchain is funded — the $1 is in it."));
  }
  if (onchain.tokenBalance == null) {
    checks.push(skipped("escrow balance", "The escrow's balance could not be read onchain, so it was skipped."));
  } else if (onchain.price != null && onchain.tokenBalance < onchain.price) {
    checks.push(failed("escrow balance", "The escrow onchain holds less than the job's price."));
  } else {
    checks.push(passed("escrow balance", "The escrow onchain holds the job's price."));
  }
  return finish(true);
}

export interface InvestigateBillSwapDeps {
  /** Contract code at an address ("" / "0x" / null when there is none). */
  codeAt: (address: string) => Promise<string | null | undefined>;
}

export interface InvestigateBillSwapInput {
  usdtAddress: string;
  reactorAddress: string;
}

/**
 * Check the contracts a bill's swap touches, before the swap is sent:
 * the USDT token and the Textile reactor must both be real contracts
 * on Celo. Throws nothing — an unreadable chain comes back as
 * readable: false and the caller waits for the next run.
 */
export async function investigateBillSwap(
  input: InvestigateBillSwapInput,
  deps: InvestigateBillSwapDeps,
): Promise<InvestigatorResult> {
  const checks: InvestigatorCheck[] = [];
  const finish = (readable: boolean): InvestigatorResult => {
    const passedAll = checks.every((c) => c.result !== "failed");
    return { passed: readable && passedAll, readable, checks, summary: summarize("swap contracts", checks) };
  };
  let usdtCode: string | null | undefined;
  let reactorCode: string | null | undefined;
  try {
    [usdtCode, reactorCode] = await Promise.all([deps.codeAt(input.usdtAddress), deps.codeAt(input.reactorAddress)]);
  } catch (err) {
    return {
      passed: false,
      readable: false,
      checks: [failed("swap contracts read", `Could not read the swap contracts onchain right now — the bill waits for the next run. (${err instanceof Error ? err.message : "unknown error"})`)],
      summary: "Investigator could not read the swap contracts onchain right now — the bill waits.",
    };
  }
  if (!usdtCode || usdtCode === "0x") {
    checks.push(failed("USDT token", "There is no USDT token contract at the address the swap would use — the bill cannot be swapped."));
  } else {
    checks.push(passed("USDT token", "The USDT token is a real contract on Celo."));
  }
  if (!reactorCode || reactorCode === "0x") {
    checks.push(failed("swap reactor", "There is no swap contract at the address the swap would use — the bill cannot be swapped."));
  } else {
    checks.push(passed("swap reactor", "The swap contract is a real contract on Celo."));
  }
  return finish(true);
}

export interface InvestigateBillPayoutInput {
  supplierWallet: string;
  agentWallet: string;
  /** The bill's amount in whole naira — the payout must be exactly this, in atomic cNGN. */
  amountNgn: number;
  cngnAddress: string;
  /** The payout calldata about to be sent — decoded and checked, not taken on trust. */
  payoutData: `0x${string}`;
}

/**
 * Check a bill's payout before the cNGN is sent: the supplier must be
 * a real address, not the zero address and not the agent wallet
 * itself; the payout calldata must be a plain transfer of exactly
 * the bill's amount to exactly the supplier; and the cNGN token must
 * be a real contract on Celo.
 */
export async function investigateBillPayout(
  input: InvestigateBillPayoutInput,
  deps: InvestigateBillSwapDeps,
): Promise<InvestigatorResult> {
  const checks: InvestigatorCheck[] = [];
  const finish = (readable: boolean): InvestigatorResult => {
    const passedAll = checks.every((c) => c.result !== "failed");
    return { passed: readable && passedAll, readable, checks, summary: summarize("supplier payout", checks) };
  };
  if (!isAddress(input.supplierWallet)) {
    checks.push(failed("supplier wallet", "The supplier's wallet is not a real wallet address — the bill cannot be paid."));
    return finish(true);
  }
  checks.push(passed("supplier wallet", "The supplier's wallet is a real address."));
  if (input.supplierWallet.toLowerCase() === zeroAddress) {
    checks.push(failed("supplier wallet", "The supplier's wallet is the zero address — nobody owns it, so the bill cannot be paid."));
    return finish(true);
  }
  if (input.supplierWallet.toLowerCase() === input.agentWallet.toLowerCase()) {
    checks.push(failed("supplier wallet", "The supplier's wallet is the agent wallet itself — a bill cannot pay itself."));
    return finish(true);
  }
  checks.push(passed("supplier wallet", "The supplier's wallet is not the agent wallet."));
  // The payout itself, decoded: a plain transfer of exactly the bill's
  // amount, to exactly the supplier. Anything else stops the payout.
  if (!Number.isInteger(input.amountNgn) || input.amountNgn <= 0) {
    checks.push(failed("payout amount", "The bill's amount is not a whole number of naira — the bill cannot be paid until it is."));
    return finish(true);
  }
  const expectedAmount = (BigInt(input.amountNgn) * 1_000_000n).toString();
  let decoded: { functionName: string; args: readonly unknown[] } | null = null;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: input.payoutData });
  } catch {
    decoded = null;
  }
  if (!decoded || decoded.functionName !== "transfer" || decoded.args.length !== 2) {
    checks.push(failed("payout amount", "The payout is not a plain transfer to the supplier — the bill cannot be paid."));
    return finish(true);
  }
  const [to, amount] = decoded.args as [string, bigint];
  if (to.toLowerCase() !== input.supplierWallet.toLowerCase()) {
    checks.push(failed("payout amount", "The payout would go to a different wallet than the supplier — the bill cannot be paid."));
    return finish(true);
  }
  if (amount.toString() !== expectedAmount) {
    checks.push(failed("payout amount", "The payout amount is not the bill's amount — the bill cannot be paid until they match."));
    return finish(true);
  }
  checks.push(passed("payout amount", "The payout is a plain transfer of exactly the bill's amount to the supplier."));
  let code: string | null | undefined;
  try {
    code = await deps.codeAt(input.cngnAddress);
  } catch (err) {
    return {
      passed: false,
      readable: false,
      checks: [failed("cNGN token read", `Could not read the cNGN token onchain right now — the payout waits for the next run. (${err instanceof Error ? err.message : "unknown error"})`)],
      summary: "Investigator could not read the cNGN token onchain right now — the payout waits.",
    };
  }
  if (!code || code === "0x") {
    checks.push(failed("cNGN token", "There is no cNGN token contract at the address the payout would use — the bill cannot be paid."));
  } else {
    checks.push(passed("cNGN token", "The cNGN token is a real contract on Celo."));
  }
  return finish(true);
}
