import { describe, expect, it } from "vitest";
import { parseDuckDuckGoLite, pageTextFromHtml, unwrapDuckDuckGoLink } from "./search.js";

const DDG_HTML = `
<html><body>
<a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpaystack&amp;rut=abc">Paystack vs Flutterwave</a>
<a class="result-link" href="https://example.com/moniepoint">Moniepoint in Lagos</a>
<a class="result-link" href="//duckduckgo.com/y.js">not a result</a>
</body></html>`;

describe("Scout search parsing (offline fixtures)", () => {
  it("unwraps DuckDuckGo redirect links to the real page", () => {
    expect(unwrapDuckDuckGoLink("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpaystack&rut=abc")).toBe("https://example.com/paystack");
    expect(unwrapDuckDuckGoLink("https://example.com/x")).toBe("https://example.com/x");
    expect(unwrapDuckDuckGoLink("/relative")).toBeNull();
  });
  it("parses DuckDuckGo Lite results and drops internal links", () => {
    const results = parseDuckDuckGoLite(DDG_HTML);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "Paystack vs Flutterwave", url: "https://example.com/paystack" });
    expect(results[1].url).toBe("https://example.com/moniepoint");
  });
  it("strips scripts, styles and tags from a page", () => {
    const text = pageTextFromHtml(`<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body><h1>Paystack</h1><p>Founded in 2015 &amp; based in Lagos.</p></body></html>`);
    expect(text).toContain("Paystack");
    expect(text).toContain("Founded in 2015 & based in Lagos.");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });
});

describe("parseBingHtml", () => {
  it("parses Bing result blocks", async () => {
    const { parseBingHtml, unwrapBingLink } = await import("./search.js");
    // u=a1 + base64("https://paystack.com/")
    expect(unwrapBingLink("https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9wYXlzdGFjay5jb20v&ntb=1")).toBe("https://paystack.com/");
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9wYXlzdGFjay5jb20v&amp;ntb=1" h="x">Paystack — payments for Africa</a></h2></li><li class="b_algo"><h2><a href="https://example.com/moniepoint">Moniepoint</a></h2></li>`;
    const results = parseBingHtml(html);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Paystack — payments for Africa");
    expect(results[0].url).toBe("https://paystack.com/");
    expect(results[1].url).toBe("https://example.com/moniepoint");
  });
});
