import { describe, expect, it } from "vitest";
import { deliverableHashFor } from "@ikenga/payments";
import { deliverWork } from "./messenger.js";

describe("deliverWork — Messenger packs the finished work and delivers it", () => {
  it("writes a delivery receipt with the deliverable's fingerprint", () => {
    const content = { report: "# Payment options\n\nPaystack charges 1.5%." };
    const { step, receipt } = deliverWork(content, "report");
    expect(step.agent).toBe("Messenger");
    expect(step.what).toContain("Packed the report and delivered it on your job page.");
    expect(step.detail).toContain(receipt.hash);
    expect(step.detail).toContain("on this page");
    expect(receipt.hash).toBe(deliverableHashFor(content));
    expect(receipt.noun).toBe("report");
    expect(receipt.where).toBe("your job page");
    expect(receipt.deliveredAt.length).toBeGreaterThan(0);
  });

  it("uses the same fingerprint the boss seals onchain — same work, same hash", () => {
    const html = "<h1>Ada's Kitchen</h1><p>Jollof rice.</p>";
    const a = deliverWork({ html }, "website");
    const b = deliverWork({ html }, "website");
    expect(a.receipt.hash).toBe(b.receipt.hash);
    expect(a.receipt.hash).toBe(deliverableHashFor({ html }));
    const different = deliverWork({ html: "<h1>Someone else</h1>" }, "website");
    expect(different.receipt.hash).not.toBe(a.receipt.hash);
  });

  it("packs a slideshow the same way, with no model call and no money moved", () => {
    const slides = [
      { title: "Ada's Kitchen", text: "Jollof rice, ₦2,500 a plate." },
      { title: "Order", text: "WhatsApp 0803 123 4567." },
    ];
    const { step, receipt } = deliverWork({ slides }, "slideshow");
    expect(step.agent).toBe("Messenger");
    expect(step.what).toContain("Packed the slideshow");
    expect(receipt.hash).toBe(deliverableHashFor({ slides }));
  });
});
