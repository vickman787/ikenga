import { NextRequest, NextResponse } from "next/server";
import { privateJson, sameOrigin, walletSession } from "@/lib/walletSession";
import { publicActivity } from "@/lib/publicActivity";

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const preview = process.env.NEXT_PUBLIC_IKENGA_READ_ONLY === "1";
  if (/^\/api\/auth\/(challenge|session)$/.test(pathname)) return NextResponse.next();
  if (preview && request.method !== "GET" && request.method !== "HEAD") return privateJson({ error: "This preview is read-only. No jobs, payments, or other records can be changed here." }, 405);
  const jobPath = /^\/api\/jobs(?:\/([^/]+)(?:\/.*)?)?$/.exec(pathname);
  const headers = new Headers(request.headers);
  // Never accept a caller's claim that an earlier authorization check succeeded.
  headers.delete("x-ikenga-verified-access");
  let address: string | null = null;

  if (preview && jobPath) {
    address = walletSession(request)?.address ?? null;
    if (!address) return privateJson({ error: "Sign in with the wallet that owns this job.", code: "SIGN_IN_REQUIRED" }, 401);
    if (request.method !== "GET" && request.method !== "HEAD" && !sameOrigin(request)) return privateJson({ error: "Use the Ikenga site to manage your job." }, 403);

  }
  if (!preview) {
    const response = NextResponse.next({ request: { headers } });
    if (jobPath) { response.headers.set("cache-control", "private, no-store"); response.headers.set("vary", "Cookie"); }
    return response;
  }
  if (!/^\/api\/(chain|quote|cfo|vault|traction|jobs(?:\/[^/]+)?|bills(?:\/[^/]+)?)$/.test(pathname)) return privateJson({ error: "This API is not available in the read-only preview." }, 404);
  try {
    const response = await fetch(new URL(pathname + search, "https://www.useikenga.xyz"), { method: request.method, headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(25_000) });
    // Private routes must be checked here too: the older production API has no ownership checks yet.
    if (jobPath || pathname === "/api/cfo") {
      if (request.method === "HEAD") return new NextResponse(null, { status: 405 });
      const data = await response.json();
      if (!response.ok) return privateJson({ error: "The live record could not be read." }, response.status);
      if (pathname === "/api/cfo") return privateJson(publicActivity(data));
      if (!jobPath![1]) {
        const jobs = Array.isArray(data.jobs) ? data.jobs.filter((job: {customerWallet?: string}) => job.customerWallet?.toLowerCase() === address!.toLowerCase()) : [];
        return privateJson({ jobs });
      }
      if (data.job?.customerWallet?.toLowerCase() !== address!.toLowerCase()) return privateJson({ error: "This job is not available to this wallet." }, 404);
      return privateJson(data);
    }
    return new NextResponse(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
  } catch { return privateJson({ error: "The preview could not read the live data right now. Please try again." }, 502); }
}
export const config = { matcher: "/api/:path*" };
