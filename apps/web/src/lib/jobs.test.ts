import { describe, expect, it } from "vitest";
import { createHire, ESTIMATED_TOOL_COST_USDC, HireInputSchema, listHires } from "./jobs.js";

describe("HireInputSchema", () => {
  it("accepts a valid hire and rejects a bad wallet", () => {
    expect(
      HireInputSchema.safeParse({
        jobType: "website",
        description: "A site for my shop",
        customerWallet: "0x0000000000000000000000000000000000000001",
      }).success,
    ).toBe(true);
    expect(
      HireInputSchema.safeParse({
        jobType: "website",
        description: "A site",
        customerWallet: "not-a-wallet",
      }).success,
    ).toBe(false);
    expect(
      HireInputSchema.safeParse({ jobType: "rocket", description: "x", customerWallet: "0x0000000000000000000000000000000000000001" })
        .success,
    ).toBe(false);
  });
});

describe("createHire (Step 1 hire flow)", () => {
  it("creates a $1 draft order with a CFO quote and a decision hash", async () => {
    const before = listHires().length;
    const hire = await createHire({
      jobType: "flyers",
      description: "Flyers for a market stall",
      customerWallet: "0x0000000000000000000000000000000000000002",
    });
    expect(hire.status).toBe("draft");
    expect(hire.priceUsdc).toBe(1);
    expect(hire.bondUsdc).toBeGreaterThan(0);
    expect(hire.cfoAccepted).toBe(true);
    expect(hire.decisionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(listHires().length).toBe(before + 1);
    expect(ESTIMATED_TOOL_COST_USDC.flyers).toBe(0.4);
  });
});
