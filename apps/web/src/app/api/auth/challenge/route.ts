import { makeChallenge, privateJson, sameOrigin } from "@/lib/walletSession";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return privateJson({ error: "Sign in from the Ikenga site." }, 403);
  const body = await request.json().catch(() => null);
  if (typeof body?.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) return privateJson({ error: "Connect a valid wallet first." }, 400);
  try { return makeChallenge(request, body.address); }
  catch { return privateJson({ error: "Wallet sign-in is not configured yet. Please try again later." }, 503); }
}
