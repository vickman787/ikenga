/**
 * Scout's search — free, no key, no account.
 *
 * Three sources, all free and keyless:
 *   1. Bing (bing.com/search) — real web results. Verified live 2026-11-22.
 *   2. DuckDuckGo Lite (lite.duckduckgo.com/lite) — a second web search.
 *      It sometimes answers with an empty page (bot-check), so it is a
 *      backup, not the only source.
 *   3. Wikipedia API (en.wikipedia.org/w/api.php) — background facts.
 *
 * Scout then fetches the result pages themselves and reads the text, so
 * every fact in a report comes from a page it actually read — never from
 * memory, never invented. A page that will not load is skipped, not faked.
 * Cost: $0 per report.
 */

export interface SearchResult {
  title: string;
  url: string;
}

export interface SourcePage {
  retrievedAt?: string;
  title: string;
  url: string;
  /** Plain text pulled from the page, trimmed to a few thousand chars. */
  text: string;
}

/** DuckDuckGo Lite only answers a full browser user-agent (a bare
 * "Mozilla/5.0" gets an empty page — verified live 2026-11-22). */
const UA = "Ikenga/0.1 (Celo hackathon market reports; contact via github.com/vickman787/ikenga)";
/** DuckDuckGo Lite only answers a full browser user-agent — a bare
 * "Mozilla/5.0" gets an empty page (verified live 2026-11-22). */
const DDG_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Pull the real target URL out of a DuckDuckGo redirect link. */
export function unwrapDuckDuckGoLink(href: string): string | null {
  try {
    if (href.startsWith("//duckduckgo.com/l/?uddg=")) {
      const u = new URL(`https:${href}`);
      const target = u.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
      return null;
    }
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    return null;
  } catch {
    return null;
  }
}

/** Parse DuckDuckGo Lite HTML into result links. Pure — testable offline. */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  // Result links look like: <a class="result-link" href="...">Title</a>
  const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = unwrapDuckDuckGoLink(decodeEntities(m[1]));
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!url || !title) continue;
    if (url.includes("duckduckgo.com")) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url });
  }
  return out;
}

/** Strip a page down to readable text. Pure — testable offline. */
export function pageTextFromHtml(html: string, maxChars = 4000): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = decodeEntities(t).replace(/\s+/g, " ").trim();
  return t.slice(0, maxChars);
}

export interface SearchDeps {
  fetchFn?: typeof fetch;
}

/** Decode a Bing redirect link (bing.com/ck/a?...&u=a1<base64>) to the
 * real page URL. Pure — testable offline. */
export function unwrapBingLink(href: string): string | null {
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href);
    const encoded = u.searchParams.get("u");
    if (!encoded) return null;
    const b64 = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
    return null;
  } catch {
    return null;
  }
}

/** Parse Bing HTML into result links. Pure — testable offline.
 * Bing wraps real links in a redirect (bing.com/ck/a?...) — the real
 * target is base64 in the `u` parameter, decoded here. */
export function parseBingHtml(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const re = /<li class="b_algo"[^>]*>[\s\S]*?<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeEntities(m[1]);
    const url = raw.includes("bing.com/ck/a") ? unwrapBingLink(raw) : raw;
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim();
    if (!url || !title) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url });
  }
  return out;
}

/** Web search via Bing. Returns up to `limit` real results. */
export async function searchBing(query: string, limit = 8, deps: SearchDeps = {}): Promise<SearchResult[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`;
  const res = await fetchFn(url, {
    headers: { "User-Agent": DDG_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Search failed (${res.status}) — Scout could not look anything up.`);
  const html = await res.text();
  return parseBingHtml(html).slice(0, limit);
}
/** Web search via DuckDuckGo Lite. Returns up to `limit` real results.
 * Retries once with a fresh request when the first comes back empty —
 * the Lite endpoint sometimes answers a first request with no results. */
export async function searchWeb(query: string, limit = 8, deps: SearchDeps = {}): Promise<SearchResult[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchFn(url, {
      headers: { "User-Agent": DDG_UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Search failed (${res.status}) — Scout could not look anything up.`);
    const html = await res.text();
    const results = parseDuckDuckGoLite(html).slice(0, limit);
    if (results.length > 0 || attempt === 1) return results;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}

/** Background facts from Wikipedia: search, then a short extract per page. */
export async function searchWikipedia(query: string, limit = 2, deps: SearchDeps = {}): Promise<SourcePage[]> {
  const fetchFn = deps.fetchFn ?? fetch;
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${limit}`;
  const sres = await fetchFn(searchUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!sres.ok) return [];
  const sdata = (await sres.json()) as { query?: { search?: { title: string }[] } };
  const titles = (sdata.query?.search ?? []).map((s) => s.title);
  const pages: SourcePage[] = [];
  for (const title of titles) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(title)}&format=json`;
      const res = await fetchFn(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { query?: { pages?: Record<string, { extract?: string }> } };
      const page = Object.values(data.query?.pages ?? {})[0];
      if (page?.extract) {
        pages.push({ title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, text: page.extract.slice(0, 3000) });
      }
    } catch {
      // One unreadable page never stops the report — Scout moves on.
    }
  }
  return pages;
}

/** Fetch one page and read its text. Returns null when it will not load.
 * Follows redirects and records the final URL (Bing result links are
 * redirects — the source shown is the page actually read). */
export async function fetchPageText(url: string, deps: SearchDeps = {}): Promise<SourcePage | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn(url, {
      headers: { "User-Agent": DDG_UA },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|text\/plain/.test(contentType)) return null;
    const html = await res.text();
    const text = pageTextFromHtml(html, 20000);
    if (text.length < 80) return null;
    const finalUrl = res.url && res.url !== url ? res.url : url;
    return { title: finalUrl, url: finalUrl, text };
  } catch {
    return null;
  }
}
