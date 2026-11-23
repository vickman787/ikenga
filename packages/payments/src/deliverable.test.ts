import { describe, expect, it } from "vitest";
import { deliverableHashFor } from "./deliverable.js";

describe("deliverableHashFor", () => {
  it("is deterministic: the same work always gives the same hash", () => {
    const content = { report: "# Report\n\nPaystack charges 1.5%." };
    expect(deliverableHashFor(content)).toBe(deliverableHashFor(content));
    expect(deliverableHashFor({ report: "# Report\n\nPaystack charges 1.5%." })).toBe(deliverableHashFor(content));
    expect(deliverableHashFor(content)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when the work changes, and never hashes to zero for real content", () => {
    const zero = `0x${"0".repeat(64)}` as `0x${string}`;
    const report = deliverableHashFor({ report: "Paystack charges 1.5%." });
    expect(deliverableHashFor({ report: "Paystack charges 1.4%." })).not.toBe(report);
    expect(deliverableHashFor({ html: "<h1>Paystack charges 1.5%.</h1>" })).not.toBe(report);
    expect(deliverableHashFor({ slides: [{ title: "Paystack", text: "Charges 1.5%." }] })).not.toBe(report);
    expect(deliverableHashFor({ slides: [{ title: "Paystack", text: "Charges 1.4%." }] })).not.toBe(
      deliverableHashFor({ slides: [{ title: "Paystack", text: "Charges 1.5%." }] }),
    );
    for (const hash of [
      report,
      deliverableHashFor({ html: "<h1>Ada's Kitchen</h1>" }),
      deliverableHashFor({ slides: [{ title: "Real food", text: "Home cooking in Lekki." }] }),
      deliverableHashFor({}),
    ]) {
      expect(hash).not.toBe(zero);
    }
  });

  it("ignores which fields are absent: report-only and html-only hashes differ", () => {
    expect(deliverableHashFor({ report: "same words" })).not.toBe(deliverableHashFor({ html: "same words" }));
    // Extra empty fields don't change the hash.
    expect(deliverableHashFor({ report: "same words", html: "" })).toBe(deliverableHashFor({ report: "same words" }));
  });
});
