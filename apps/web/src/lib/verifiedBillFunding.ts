import type { FundingTransferCheck } from "@ikenga/payments";
import type { BillFundingReport } from "./bills";

/** Normalize a report only after checking its transaction onchain. */
export function verifiedBillFundingReport(
  report: BillFundingReport,
  check: FundingTransferCheck,
  expected: { token: string; recipient: string },
): BillFundingReport | null {
  if (check.ok) return report;
  if (
    check.reason !== "wrong amount" ||
    check.from?.toLowerCase() !== report.payerWallet.toLowerCase() ||
    check.to?.toLowerCase() !== expected.token.toLowerCase() ||
    check.recipient?.toLowerCase() !== expected.recipient.toLowerCase() ||
    check.amountAtomic === null ||
    check.amountAtomic <= 0n
  ) {
    return null;
  }
  return { ...report, amountAtomic: check.amountAtomic.toString() };
}

