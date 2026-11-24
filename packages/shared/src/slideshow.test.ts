import { describe, expect, it } from "vitest";
import { buildStandaloneSlideshowHtml } from "./slideshow.js";

const FAKE_IMG = "data:image/jpeg;base64,/9j/FAKEBASE64==";

const SLIDES = [
  { title: "Real food from Ada's Kitchen", text: "Home cooking in Lekki, made fresh every day.", image: FAKE_IMG },
  { title: "What we cook", text: "Jollof rice, small chops, and catering for parties." },
  { title: "Order now", text: "WhatsApp 0803 123 4567, Lekki Phase 1." },
];

describe("buildStandaloneSlideshowHtml", () => {
  it("contains every slide's words, and the picture on the first slide only", () => {
    const html = buildStandaloneSlideshowHtml(SLIDES);
    for (const slide of SLIDES) {
      expect(html).toContain(slide.title);
      expect(html).toContain(slide.text);
    }
    expect(html).toContain(FAKE_IMG);
    expect(html.indexOf(FAKE_IMG)).toBeLessThan(html.indexOf("What we cook"));
    // One <img> in the whole file — the picture lives on the first slide.
    expect(html.match(/<img\b/g)?.length).toBe(1);
  });

  it("is fully standalone: no scripts, no external links", () => {
    const html = buildStandaloneSlideshowHtml(SLIDES);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).toContain("@keyframes ikenga-show");
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("escapes words from the brief instead of trusting them as HTML", () => {
    const html = buildStandaloneSlideshowHtml([
      { title: "<script>alert(1)</script>", text: "A & B <b>bold</b>" },
    ]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A &amp; B");
  });

  it("skips a picture that is not a data URI", () => {
    const html = buildStandaloneSlideshowHtml([
      { title: "Hook", text: "Words.", image: "https://evil.example/x.png" },
    ]);
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<img");
  });

  it("sequences the slides: each slide shows only in its own window", () => {
    const html = buildStandaloneSlideshowHtml(SLIDES);
    // 3 slides → a 12s cycle; each slide is visible for 4s, so the
    // fade-out lands at 4/12 = 33.3% of the cycle, not near the end.
    expect(html).toContain("33.3% { opacity: 0; }");
    expect(html).not.toContain("85% { opacity: 1; }");
    // Positive delays, 4s apart — each slide's whole timeline runs
    // that far behind the one before, so they play in order, forever.
    // (Negative delays would start each slide part-way into the cycle
    // and play them in reverse — caught by a real-time screenshot.)
    expect(html).toContain("animation-delay:4s");
    expect(html).toContain("animation-delay:8s");
    expect(html).not.toContain("animation-delay:-");
  });

  it("still returns a valid file with no slides", () => {
    const html = buildStandaloneSlideshowHtml([]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("No slides");
  });
});
