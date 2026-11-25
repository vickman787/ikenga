import { NextRequest, NextResponse } from "next/server";

/** Preview-only public reads. Production and normal local runs pass through. */
export async function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_IKENGA_READ_ONLY !== "1") return NextResponse.next();
  if (request.method !== "GET" && request.method !== "HEAD") {
    return NextResponse.json({ error: "This preview is read-only. No jobs, payments, or other records can be changed here." }, { status: 405 });
  }
  const { pathname, search } = request.nextUrl;
  if (!/^\/api\/(chain|quote|cfo|vault|traction|jobs(?:\/[^/]+)?|bills(?:\/[^/]+)?)$/.test(pathname)) {
    return NextResponse.json({ error: "This API is not available in the read-only preview." }, { status: 404 });
  }
  try {
    // Never forward cookies, authorization, or private preview environment values.
    const response = await fetch(new URL(pathname + search, "https://www.useikenga.xyz"), {
      method: request.method,
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    return new NextResponse(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "The preview could not read the live data right now. Please try again." }, { status: 502 });
  }
}

export const config = { matcher: "/api/:path*" };
