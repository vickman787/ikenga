import { logoMarkPngBytes } from "@/lib/logo";

/** Serves the Ikenga mark as the site icon (see src/lib/logo.ts). */
export function GET() {
  return new Response(new Uint8Array(logoMarkPngBytes()), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
