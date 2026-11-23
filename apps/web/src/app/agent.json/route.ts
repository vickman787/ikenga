import { agentRegistration } from "@/lib/agentRegistration";

export const dynamic = "force-dynamic";

/**
 * Serves Ikenga's ERC-8004 agent registration file at /agent.json.
 * This is the agentURI the on-chain identity points at. It is served
 * fresh (not cached long) because the `registrations` array gains the
 * agentId after the mint.
 */
export function GET() {
  return Response.json(agentRegistration(), {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
