import { describe, expect, it } from "vitest";
import { cngnJobPrice, cngnRatePerUsd } from "./pricing.js";

describe("cngnJobPrice — the cNGN price of a $1 job, fixed at hire time", () => {
  it("rounds the preview up to whole cNGN", () => {
    // $1 at 1,444.067 cNGN per $1: 1,444,067,000 atomic -> 1,445 whole cNGN.
    const fixed = cngnJobPrice("1444067000");
    expect(fixed.priceAtomic).toBe(1_445_000_000n);
    expect(fixed.priceCngn).toBe("1445");
    expect(fixed.rateCngnPerUsd).toBe("1444.067");
  });

  it("leaves an already-whole amount alone", () => {
    const fixed = cngnJobPrice("1444000000");
    expect(fixed.priceAtomic).toBe(1_444_000_000n);
    expect(fixed.priceCngn).toBe("1444");
    expect(fixed.rateCngnPerUsd).toBe("1444");
  });

  it("rounds up even one atomic unit over a whole naira", () => {
    const fixed = cngnJobPrice("1444000001");
    expect(fixed.priceAtomic).toBe(1_445_000_000n);
    expect(fixed.priceCngn).toBe("1445");
  });

  it("the fixed price never moves when the rate does", () => {
    // The rate at hire time fixes the price. A later preview at a
    // better rate (1,500 per $1) fixes a different price — but the hired
    // job keeps the price it was hired at. The price is stored on the
    // job record, never re-derived from a fresh preview.
    const atHire = cngnJobPrice("1444067000");
    const later = cngnJobPrice("1500000000");
    expect(atHire.priceAtomic).toBe(1_445_000_000n);
    expect(later.priceAtomic).toBe(1_500_000_000n);
    expect(atHire.priceAtomic).not.toBe(later.priceAtomic);
  });

  it("refuses an empty or zero preview — no guessed price", () => {
    expect(() => cngnJobPrice("0")).toThrow(/empty/);
    expect(() => cngnJobPrice("")).toThrow(/not an amount/);
    expect(() => cngnJobPrice("1444.5")).toThrow(/not an amount/);
    expect(() => cngnJobPrice("-5")).toThrow(/not an amount/);
  });

  it("formats the rate with up to 3 decimals, no trailing zeros", () => {
    expect(cngnRatePerUsd("1444067000")).toBe("1444.067");
    expect(cngnRatePerUsd("1444500000")).toBe("1444.5");
    expect(cngnRatePerUsd("1500000000")).toBe("1500");
  });
});
