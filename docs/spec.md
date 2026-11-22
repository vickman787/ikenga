# Ikenga — product spec (Step 1)

**Name:** Ikenga — Igbo god of achievement, personal power and enterprise.
**Tagline:** Agents do the work. The CFO runs the money.
**Hackathon:** Celo "Agents Open for Business" (Nov 20 – Dec 7, 2026, 09:00 GMT).
**Tracks:** (1) Stablecoin Corridors ($2,000) and (3) Self Agent ID ($1,000).
**Chain:** Celo mainnet only (chain 42220). Code written during the hackathon.

## What it is

Ikenga is a company staffed by AI agents that does $1 jobs for Nigerian small
businesses: business websites, promo videos, flyers & price lists, and market
reports. A customer pays $1 into escrow and pays only if they accept the work;
rejection refunds the price plus a bond the CFO put up.

An AI CFO prices every job, holds the escrow, funds the agents, and signs
every decision. **No language model touches money** — pricing, allocation and
top-ups are deterministic code with on-chain limits. Agents pay for their own
tools per call via x402 on Celo.

## The two tracks, concretely

### Track 1 — Stablecoin Corridors (Textile FX, USDT ↔ cNGN)

The naira leg. When a job is paid in naira or a supplier must be paid in
naira, the CFO converts USDT to cNGN on Textile FX (Celo LimitOrderReactor
`0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`; cNGN
`0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f`, USDT
`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`, both 6 decimals). The agent
requests a firm RFQ quote for the exact size; the swap settles in a single
on-chain transaction. Gas is paid in stablecoin via CIP-64, so the agent
never needs CELO in its wallet.

Named user (to be confirmed in Step 2): a Lagos small business that earns in
USDT and pays a naira supplier — the job, the conversion and the cNGN payment
to the supplier's wallet are all on-chain and tagged.

### Track 3 — Self Agent ID (verified agent payments)

Before the CFO serves or pays an agent, the agent's Self Agent ID must verify.
No verified identity, no payment, no service. The gate is a single function
in `packages/payments` (`verifySelfAgentId`); in Step 1 it is a stub that
defaults to closed. Payments go through x402 via Celo's facilitator
(`https://api.x402.celo.org`, network `eip155:42220`).

## Rules the product enforces

- **Deterministic CFO:** pricing is a pure function (`priceJob` in
  `packages/shared`): flat $1 price, bond 10–30% by confidence, expected
  profit floor −3.50 USDC; decline below the floor.
- **Escrow:** customer pays into `JobEscrow`; accept releases to the vault,
  reject refunds + bond, silence/deadline releases per contract rules.
- **Pinned payees:** an agent's tool sellers are pinned in code; a changed
  payee is refused and logged.
- **No double-pay:** after signing, a payment is retried only if the seller
  says it declined; a timeout after signing is ambiguous and is never
  retried.
- **Hash-chained audit log:** every CFO decision is appended to a sha256
  chain and signed; `verifyChain` recomputes it. The log is public.
- **Attribution:** every counted transaction carries the ERC-8021 tag, and
  every agent is registered on ERC-8004 (IdentityRegistry
  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`).

## What is stubbed in Step 1

- Payments: x402 verify/settle, Textile FX RFQ, Self Agent ID check — all
  stubs that say so and move nothing.
- Contracts: `JobEscrow` and `IkengaVault` compile and deploy in tests, but
  every money function reverts. Not audited, not deployed.
- Jobs: the web hire flow stores orders in server memory only. No escrow, no
  real conversion, no real payment.

## What Ikenga is

Ikenga is a fresh implementation built for Celo: $1 jobs, escrow, a
deterministic CFO and a signed audit log, with the naira leg on Textile FX
USDT↔cNGN, Celo's x402 facilitator, and a Self Agent ID gate before any
agent is served or paid.
