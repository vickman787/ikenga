import { clearSession, finishChallenge, privateJson, sameOrigin, walletSession } from "@/lib/walletSession";
import type { Hex } from "viem";
export async function GET(request: Request) {
  const session = walletSession(request);
  return privateJson({ address: session?.address ?? null, expires: session?.expires ?? null });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return privateJson({ error: "Sign in from the Ikenga site." }, 403);
  const body = await request.json().catch(() => null);
  if (typeof body?.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return privateJson({ error: "A valid wallet signature is required." }, 400);
  return finishChallenge(request, body.signature as Hex);
}
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return privateJson({ error: "Use the Ikenga site to sign out." }, 403);
  return clearSession(request);
}
