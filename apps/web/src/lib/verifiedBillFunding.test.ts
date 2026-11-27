import { describe, expect, it } from "vitest";
import type { FundingTransferCheck } from "@ikenga/payments";
import { verifiedBillFundingReport } from "./verifiedBillFunding";

const report = {
  txHash: `0x${"a".repeat(64)}`,
  payerWallet: "0x00000000000000000000000000000000000000aa",
  amountAtomic: "1040000",
};
const expected = {
  token: "0x0000000000000000000000000000000000000011",
  recipient: "0x0000000000000000000000000000000000000022",
};
function check(overrides: Partial<FundingTransferCheck> = {}): FundingTransferCheck {
  return {
    ok: false,
    reason: "wrong amount",
    from: report.payerWallet as `0x${string}`,
    to: expected.token as `0x${string}`,
    recipient: expected.recipient as `0x${string}`,
    amountAtomic: 1_100_000n,
    ...overrides,
  };
}

describe("verifiedBillFundingReport", () => {
  it("credits the actual amount of a valid on-chain USDT transfer", () => {
    expect(verifiedBillFundingReport(report, check(), expected)).toEqual({ ...report, amountAtomic: "1100000" });
  });

  it("keeps an exact verified transfer unchanged", () => {
    expect(verifiedBillFundingReport(report, check({ ok: true, reason: null }), expected)).toBe(report);
  });

  it.each([
    { from: "0x00000000000000000000000000000000000000bb" },
    { to: "0x0000000000000000000000000000000000000033" },
    { recipient: "0x0000000000000000000000000000000000000044" },
    { amountAtomic: 0n },
    { amountAtomic: null },
    { reason: "reverted" },
  ] as Partial<FundingTransferCheck>[]) ("does not credit a failed safety check: %o", (overrides) => {
    expect(verifiedBillFundingReport(report, check(overrides), expected)).toBeNull();
  });
});

