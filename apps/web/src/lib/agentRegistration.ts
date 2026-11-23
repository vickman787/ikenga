/**
 * Ikenga's ERC-8004 agent registration file (EIP-8004, registration-v1).
 *
 * This is the file the on-chain agent identity points at: the IdentityRegistry
 * stores its URL as the agent's `agentURI`, and anyone can fetch it to learn
 * what Ikenga is and where it is registered.
 *
 * Two-phase flow (see contracts/script/RegisterAgent.s.sol and
 * docs/step2-plan.md §2.4): mint first with an empty `registrations` array,
 * then patch the returned `agentId` into `IKENGA_AGENT_ID` below and
 * redeploy — the URL stays the same, so no on-chain update is needed.
 *
 * Keep every claim in here honest: no fake customers, counts, or promises.
 * What Ikenga does today is the four $1 jobs on the live site, with an AI
 * CFO running the money on Celo.
 */

/** The on-chain ERC-8004 agentId for Ikenga on Celo mainnet. Minted 2026-11-23, tx 0x4a27e75e4f84a8588789183e5330b7f2db628a999046d590cb2328aef3d782ef, block 83516978. */
export const IKENGA_AGENT_ID: number | null = 10106;

/** The IdentityRegistry Ikenga is registered on, as an EIP-8004 agentRegistry string. */
export const IKENGA_AGENT_REGISTRY =
  "eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/** The Loops agent wallet — the owner of the agent identity. */
export const IKENGA_AGENT_WALLET = "0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0";

export const IKENGA_SITE_URL = "https://ikenga-two.vercel.app";

export interface AgentRegistrationEntry {
  agentId: number;
  agentRegistry: string;
}

export function agentRegistration() {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Ikenga",
    description:
      "Ikenga is a team of AI agents that do small jobs for Nigerian small businesses — a website, a flyer and price list, a promo slideshow, or a market report — for $1 a job. An AI CFO runs the money on Celo: customers pay into escrow, agents pay for their tools with x402, and money moves to naira through Textile FX (USDT to cNGN). Agents only get paid after the customer accepts the work.",
    image: `${IKENGA_SITE_URL}/logo.png`,
    owner: IKENGA_AGENT_WALLET,
    services: [
      { name: "web", endpoint: `${IKENGA_SITE_URL}/` },
      { name: "cfo", endpoint: `${IKENGA_SITE_URL}/api/cfo` },
    ],
    x402Support: true,
    active: true,
    registrations:
      IKENGA_AGENT_ID === null
        ? []
        : [
            {
              agentId: IKENGA_AGENT_ID,
              agentRegistry: IKENGA_AGENT_REGISTRY,
            } satisfies AgentRegistrationEntry,
          ],
    supportedTrust: ["reputation"],
  };
}
