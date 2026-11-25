import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";

export const SESSION_COOKIE = "ikenga_wallet";
export const CHALLENGE_COOKIE = "ikenga_challenge";
const SESSION_SECONDS = 3600;
interface Token { kind: "challenge" | "session"; address: Address; origin: string; expires: number; nonce?: string; message?: string }
function secret() {
  const value = process.env.IKENGA_SESSION_SECRET;
  if (!value || Buffer.byteLength(value) < 32) throw new Error("Wallet sign-in is not configured yet. Please try again later.");
  return value;
}
export function signToken(value: Token): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + createHmac("sha256", secret()).update(payload).digest("base64url");
}
export function readToken(value: string | undefined, kind: Token["kind"], origin: string): Token | null {
  if (!value || value.length > 4096) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", secret()).update(payload).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const token = JSON.parse(Buffer.from(payload, "base64url").toString()) as Token;
    if (token.kind !== kind || token.origin !== origin || !Number.isFinite(token.expires) || token.expires <= Date.now()) return null;
    getAddress(token.address);
    return token;
  } catch { return null; }
}
export function cookie(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1);
}
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  // Next may canonicalize the server hostname to localhost. Host remains the
  // browser-requested authority; never use the caller's Origin as authority.
  return new URL(url.protocol + "//" + (request.headers.get("host") ?? url.host)).origin;
}
export function walletSession(request: Request): Token | null {
  return readToken(cookie(request, SESSION_COOKIE), "session", requestOrigin(request));
}
export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === requestOrigin(request);
}
export function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "private, no-store", "vary": "Cookie" } });
}
function setCookie(response: NextResponse, request: Request, name: string, value: string, maxAge: number) {
  response.cookies.set(name, value, { httpOnly: true, secure: new URL(request.url).protocol === "https:", sameSite: "strict", path: "/", maxAge });
}
export function clearSession(request: Request) {
  const response = privateJson({ address: null });
  setCookie(response, request, SESSION_COOKIE, "", 0);
  setCookie(response, request, CHALLENGE_COOKIE, "", 0);
  return response;
}
export function makeChallenge(request: Request, addressInput: string) {
  const address = getAddress(addressInput);
  const origin = requestOrigin(request);
  const expires = Date.now() + 5 * 60_000;
  const nonce = randomBytes(24).toString("hex");
  const message = createSiweMessage({ address, chainId: process.env.IKENGA_CHAIN === "sepolia" ? 11142220 : 42220, domain: new URL(origin).host, uri: origin, version: "1", nonce, issuedAt: new Date(), expirationTime: new Date(expires), statement: "Sign in to view your Ikenga jobs. This does not authorize payments or blockchain transactions." });
  const token = signToken({ kind: "challenge", address, origin, expires, nonce, message });
  const response = privateJson({ message });
  // A new challenge replaces any previous sign-in and is bound to this browser's HttpOnly cookie.
  setCookie(response, request, SESSION_COOKIE, "", 0);
  setCookie(response, request, CHALLENGE_COOKIE, token, 300);
  return response;
}
export async function finishChallenge(request: Request, signature: Hex) {
  const challenge = readToken(cookie(request, CHALLENGE_COOKIE), "challenge", requestOrigin(request));
  if (!challenge?.message || !await verifyMessage({ address: challenge.address, message: challenge.message, signature }).catch(() => false)) {
    return privateJson({ error: "Sign-in expired or the signature did not match. Please sign in again." }, 401);
  }
  const expires = Date.now() + SESSION_SECONDS * 1000;
  const response = privateJson({ address: challenge.address, expires });
  setCookie(response, request, SESSION_COOKIE, signToken({ kind: "session", address: challenge.address, origin: challenge.origin, expires }), SESSION_SECONDS);
  setCookie(response, request, CHALLENGE_COOKIE, "", 0);
  return response;
}
