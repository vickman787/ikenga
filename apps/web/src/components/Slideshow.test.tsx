import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Slideshow from "./Slideshow";

const FAKE_IMG = "data:image/jpeg;base64,/9j/FAKEBASE64==";

const SLIDES = [
  { title: "Real food from Ada's Kitchen", text: "Home cooking in Lekki, made fresh every day.", image: FAKE_IMG },
  { title: "What we cook", text: "Jollof rice, small chops, and catering for parties." },
];

describe("Slideshow — the promo video", () => {
  it("shows the first slide's words and its picture", () => {
    const html = renderToStaticMarkup(<Slideshow slides={SLIDES} />);
    expect(html).toContain("Real food from Ada&#x27;s Kitchen");
    expect(html).toContain("Home cooking in Lekki");
    expect(html).toContain(`<img src="${FAKE_IMG}"`);
    expect(html).toContain('aria-label="Promo scene 1 of 2"');
    expect(html).toContain('aria-label="Play promo"');
    expect(html).toContain("1 of 2 scenes");
    expect(html).toContain('aria-label="Next promo scene"');
  });

  it("shows no picture when the job has none", () => {
    const html = renderToStaticMarkup(
      <Slideshow slides={[{ title: "Hook", text: "Words." }]} />,
    );
    expect(html).toContain("Hook");
    expect(html).not.toContain("<img");
  });

  it("renders nothing with no slides", () => {
    expect(renderToStaticMarkup(<Slideshow slides={[]} />)).toBe("");
  });
});
