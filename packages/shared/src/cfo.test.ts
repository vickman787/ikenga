import { describe, expect, it } from "vitest";
import { CFO_MIN_EXPECTED_PROFIT_USDC, priceJob } from "./index.js";

describe("priceJob (CFO pricing — deterministic, no model touches money)", () => {
  it("prices a cheap job with the $1 flat price and a 10% bond when no history", () => {
    const q = priceJob({ jobType: "flyers", toolCostUsdc: 0.4, accepted: 0, quoted: 0 });
    expect(q.priceUsdc).toBe(1);
    expect(q.acceptProbability).toBe(0.8);
    expect(q.bondUsdc).toBe(0.1);
    // 0.8*1 - 0.4 - 0.2*0.1 = 0.38
    expect(q.expectedProfitUsdc).toBe(0.38);
    expect(q.accepted).toBe(true);
  });

  it("is deterministic: same input, same output", () => {
    const input = { jobType: "website" as const, toolCostUsdc: 1.2, accepted: 3, quoted: 4 };
    expect(priceJob(input)).toEqual(priceJob(input));
  });

  it("raises the bond as acceptance history grows", () => {
    const fresh = priceJob({ jobType: "website", toolCostUsdc: 0.5, accepted: 0, quoted: 0 });
    const proven = priceJob({ jobType: "website", toolCostUsdc: 0.5, accepted: 40, quoted: 45 });
    expect(proven.bondUsdc).toBeGreaterThan(fresh.bondUsdc);
    expect(proven.bondUsdc).toBeLessThanOrEqual(0.3);
  });

  it("declines a job expected to lose more than the floor", () => {
    const q = priceJob({ jobType: "promo-video", toolCostUsdc: 5, accepted: 0, quoted: 10 });
    expect(q.expectedProfitUsdc).toBeLessThan(CFO_MIN_EXPECTED_PROFIT_USDC);
    expect(q.accepted).toBe(false);
    expect(q.reason).toContain("declined");
  });

  it("rejects inconsistent history", () => {
    expect(() => priceJob({ jobType: "website", toolCostUsdc: 1, accepted: 5, quoted: 2 })).toThrow();
    expect(() => priceJob({ jobType: "website", toolCostUsdc: -1, accepted: 0, quoted: 0 })).toThrow();
  });
});
