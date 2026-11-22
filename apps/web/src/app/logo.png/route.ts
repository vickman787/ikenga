import { logoPngBytes } from "@/lib/logo";

/** Serves the full Ikenga logo (see src/lib/logo.ts for why the bytes live there). */
export function GET() {
  return new Response(new Uint8Array(logoPngBytes()), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
