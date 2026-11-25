import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { connectInjected } from "./lib/contracts";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("read-only UI review deployment", () => {
  it("leaves normal application requests untouched when the preview flag is absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(new NextRequest("https://preview.example/api/jobs", { method: "POST" }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refuses writes before they can reach production", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(new NextRequest("https://preview.example/api/jobs", { method: "POST" }));
    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reads existing currency data without forwarding credentials", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ vaults: [{ currency: "USDT" }, { currency: "cNGN" }] }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await proxy(new NextRequest("https://preview.example/api/vault", { headers: { cookie: "private=secret", authorization: "Bearer private" } }));
    expect(response.status).toBe(200);
    expect((await response.json()).vaults.map((v: { currency: string }) => v.currency)).toEqual(["USDT", "cNGN"]);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("https://www.useikenga.xyz/api/vault");
    expect(options.headers).toEqual({ accept: "application/json" });
  });
  it("refuses unlisted endpoints instead of running local handlers", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await proxy(new NextRequest("https://preview.example/api/jobs/id/run"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("blocks wallet connection before a wallet provider is requested", async () => {
    vi.stubEnv("NEXT_PUBLIC_IKENGA_READ_ONLY", "1");
    const request = vi.fn(); vi.stubGlobal("window", { ethereum: { request } });
    await expect(connectInjected()).rejects.toThrow("preview is read-only");
    expect(request).not.toHaveBeenCalled();
  });
});
