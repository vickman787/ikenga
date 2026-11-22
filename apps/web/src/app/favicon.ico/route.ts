import { faviconIcoBytes } from "@/lib/logo";

/** Serves the Ikenga favicon (see src/lib/logo.ts for why the bytes live there). */
export function GET() {
  return new Response(new Uint8Array(faviconIcoBytes()), {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
