import { describe, expect, it } from "vitest";
import { decideFx, bpsGap } from "./fx.js";

const base = {
  obligationNaira: 500_000,
  minRate: 1500,
  deadline: "2026-12-07T09:00:00.000Z",
  now: "2026-11-21T10:00:00.000Z",
};

describe("decideFx()", () => {
  it("converts at or above the minimum rate", () => {
    const d = decideFx({ ...base, quote: { rate: 1550, expiresAt: "2026-11-21T11:00:00.000Z" } });
    expect(d.action).toBe("convert");
    expect(d.bpsGap).toBeGreaterThan(0);
  });

  it("refuses below the minimum rate and records the gap", () => {
    const d = decideFx({ ...base, quote: { rate: 1400, expiresAt: "2026-11-21T11:00:00.000Z" } });
    expect(d.action).toBe("refuse");
    expect(d.rateSeen).toBe(1400);
    expect(d.bpsGap).toBeLessThan(0);
    expect(d.nairaSaved).toBeGreaterThan(0);
    expect(d.reason).toContain("refusing");
  });

  it("force-converts at the deadline with the concession logged", () => {
    const d = decideFx({
      ...base,
      now: "2026-12-07T09:00:00.000Z",
      quote: { rate: 1400, expiresAt: "2026-12-07T10:00:00.000Z" },
    });
    expect(d.action).toBe("force-convert");
    expect(d.reason).toContain("concession");
  });

  it("waits when there is no quote yet", () => {
    expect(decideFx({ ...base, quote: null }).action).toBe("wait");
  });

  it("waits on an expired quote before the deadline", () => {
    const d = decideFx({ ...base, quote: { rate: 1600, expiresAt: "2026-11-21T09:00:00.000Z" } });
    expect(d.action).toBe("wait");
  });

  it("bpsGap is 0 at the minimum rate", () => {
    expect(bpsGap(1500, 1500)).toBe(0);
  });
});
