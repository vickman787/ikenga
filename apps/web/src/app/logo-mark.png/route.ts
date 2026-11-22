import { logoMarkPngBytes } from "@/lib/logo";

/** Serves the Ikenga mark (horns forming an "I", no wordmark) — used in the nav and footer. */
export function GET() {
  return new Response(new Uint8Array(logoMarkPngBytes()), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
