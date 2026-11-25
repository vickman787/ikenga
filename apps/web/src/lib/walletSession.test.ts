import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { POST as challenge } from "@/app/api/auth/challenge/route";
import { GET, POST, DELETE } from "@/app/api/auth/session/route";
import { CHALLENGE_COOKIE, SESSION_COOKIE, readToken, signToken, walletSession } from "./walletSession";
const account = privateKeyToAccount(("0x" + "1".repeat(64)) as Hex);
const other = privateKeyToAccount(("0x" + "2".repeat(64)) as Hex);
const origin = "https://ikenga.example";
function req(path: string, method: string, body?: unknown, cookie?: string, from = origin) {
  return new Request(origin + path, { method, headers: { origin: from, "content-type": "application/json", ...(cookie ? {cookie} : {}) }, ...(body ? {body: JSON.stringify(body)} : {}) });
}
beforeEach(() => vi.stubEnv("IKENGA_SESSION_SECRET", "test-only-session-secret-32-characters-long"));
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
async function start() {
  const response = await challenge(req("/api/auth/challenge", "POST", {address: account.address}));
  return { response, body: await response.json(), cookie: CHALLENGE_COOKIE + "=" + response.cookies.get(CHALLENGE_COOKIE)!.value };
}
describe("wallet ownership sign-in", () => {
  it("verifies the signature and issues a private, secure, browser-bound session", async () => {
    const c = await start();
    expect(c.body.message).toContain("ikenga.example wants you to sign in");
    expect(c.body.message).toContain("Chain ID: 42220");
    expect(c.body.message).toContain("does not authorize payments");
    const signature = await account.signMessage({message: c.body.message});
    const response = await POST(req("/api/auth/session", "POST", {signature}, c.cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.cookies.get(CHALLENGE_COOKIE)?.maxAge).toBe(0);
    const sessionCookie = SESSION_COOKIE + "=" + response.cookies.get(SESSION_COOKIE)!.value;
    expect(walletSession(req("/api/jobs", "GET", undefined, sessionCookie))?.address).toBe(account.address);
    expect((await (await GET(req("/api/auth/session", "GET", undefined, sessionCookie))).json()).address).toBe(account.address);
    const logout = await DELETE(req("/api/auth/session", "DELETE", undefined, sessionCookie));
    expect(logout.cookies.get(SESSION_COOKIE)?.maxAge).toBe(0);
  });
  it("refuses a different wallet, signature without the challenge cookie, and a modified challenge", async () => {
    const c = await start();
    const signature = await other.signMessage({message: c.body.message});
    expect((await POST(req("/api/auth/session", "POST", {signature}, c.cookie))).status).toBe(401);
    const right = await account.signMessage({message: c.body.message});
    expect((await POST(req("/api/auth/session", "POST", {signature:right}))).status).toBe(401);
    expect((await POST(req("/api/auth/session", "POST", {signature:right}, c.cookie + "tampered"))).status).toBe(401);
  });
  it("rejects expired challenges, forged sessions, and tokens for another origin", async () => {
    vi.useFakeTimers();
    const c = await start();
    const signature = await account.signMessage({message: c.body.message});
    vi.advanceTimersByTime(301_000);
    expect((await POST(req("/api/auth/session", "POST", {signature}, c.cookie))).status).toBe(401);
    const token = signToken({kind:"session", address:account.address, origin, expires:Date.now()+1000});
    expect(readToken(token + "x", "session", origin)).toBeNull();
    expect(readToken(token, "session", "https://attacker.example")).toBeNull();
    vi.advanceTimersByTime(1001);
    expect(readToken(token, "session", origin)).toBeNull();
  });
  it("refuses cross-origin sign-in and logout and fails closed without a signing secret", async () => {
    expect((await challenge(req("/api/auth/challenge", "POST", {address:account.address}, undefined, "https://attacker.example"))).status).toBe(403);
    expect((await DELETE(req("/api/auth/session", "DELETE", undefined, undefined, "https://attacker.example"))).status).toBe(403);
    vi.stubEnv("IKENGA_SESSION_SECRET", "");
    expect((await challenge(req("/api/auth/challenge", "POST", {address:account.address}))).status).toBe(503);
  });
});

it("uses the requested Host rather than Next's internal canonical hostname", async () => {
  vi.stubEnv("IKENGA_SESSION_SECRET", "test-only-session-secret-32-characters-long");
  const request = new Request("http://localhost:3002/api/auth/challenge", {method:"POST",headers:{host:"127.0.0.1:3002",origin:"http://127.0.0.1:3002","content-type":"application/json"},body:JSON.stringify({address:account.address})});
  const response = await challenge(request);
  expect(response.status).toBe(200);
  expect((await response.json()).message).toContain("127.0.0.1:3002 wants you to sign in");
  const rejected = await challenge(new Request(request.url,{method:"POST",headers:{host:"127.0.0.1:3002",origin:"http://localhost:3002","content-type":"application/json"},body:JSON.stringify({address:account.address})}));
  expect(rejected.status).toBe(403);
});
