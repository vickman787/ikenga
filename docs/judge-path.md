# Ikenga — judge path (Step 2)

Step 2 turned the skeleton into a product that moves money on Celo — with
one honest limit: the live Sepolia end-to-end job is **blocked on the user**,
not on code. Everything below that is marked verified was checked on
2026-11-21; everything marked blocked lists exactly what is missing.

## Try it in 60 seconds

1. Run the app: `pnpm install`, then `pnpm --filter @ikenga/web dev`.
   Open http://localhost:3000.
2. Pick a $1 job (website, promo video, flyers, market report), describe it,
   enter a Celo wallet address, and submit.
3. You get a job id, the $1 price, the CFO bond, and a CFO decision hash.
4. Check the public log: `GET /api/cfo` (hash-chained decisions,
   `verify.ok`), `GET /api/traction` (numbers generated from the ledger,
   never hand-typed), `GET /api/jobs/<id>` (order + decisions + FX swaps +
   reconciliation).

## What a judge can check now (verified 2026-11-21)

- **Tests:** 132 TypeScript tests pass (9 skipped, all live-gated),
  **48 Foundry tests pass** (`forge test`, escrow + vault + invariants).
  `pnpm typecheck` and `pnpm --filter @ikenga/web build` pass.
- **Contracts:** real `JobEscrow` (fund exactly 1 USDT, accept → vault,
  reject → refund + bond, 48 h deadline release) and `IkengaVault`
  (buckets, maxMove 5 USDT, per-agent allowances, bond cover,
  propose/coSign, no function sends to an arbitrary address). Not deployed,
  not audited.
- **x402 (Celo facilitator):** real verify/settle delegation, route config,
  buyer client with spend controls, `sendTagged()` — the one chokepoint
  for the agent's own txs (CIP-64 feeCurrency + ERC-8021 attribution).
  Retry header resolved: `PAYMENT-SIGNATURE` (v2). Live `/supported`
  verified: 10 mainnet assets, Sepolia USDC only.
- **Textile FX:** full RFQ client (preview / levels / firm quote / submit /
  cancel / executeSwap). Live read-only check: Celo USDT→cNGN levels —
  min $1, max ≈ $42,442, 9 levels; $10 preview → 14,440.67 cNGN
  (~₦1,444/USDT, 2 bps fee). No live swap has run (no funded wallet).
- **Self Agent ID:** real async gate (`@selfxyz/agent-sdk` 0.3.1, SDK
  lookup + direct registry read, sybil check, 1-hour cache, nullifier
  never returned/stored). Live Sepolia registry read verified: a random
  address is `NOT_REGISTERED`. No agent is registered yet.
- **ERC-8004:** registries verified read-only via cast (Sepolia
  `0x8004A818…`, mainnet `0x8004A169…`, `name() = "AgentIdentity"`).
  Registration script ready, not executed.
- **Ledger/agent:** hash-chained log now stores full entry text and
  verifies from it; `reconcile()` settles only with a tx hash; the agent
  loop is real (price → Self gate → work → x402 tool payments → FX leg →
  cNGN payout), with `decide()`/`decideFx()` pure and tested. The creative
  work itself is still a labelled stub — the money path is real, the
  deliverable is not yet automated.

## What is NOT yet checkable (blocked — needs the user)

Run `pnpm --filter @ikenga/agent exec:sepolia` — it prints the blocked list
(2/6 checks pass today: Sepolia RPC reachable, agent-run refuses
fail-closed at the unregistered Self gate).

1. **Named real user** (plan §3.1): who, what job, naira amount, supplier
   wallet, deadline, minimum rate. Without this there is no live mainnet job.
2. **Self registration**: the user scans a real passport/ID in the Self app
   (testnet: mock documents only) — `self-agent register init --mode linked`,
   then `AGENT_PRIVATE_KEY` in `.env` only. Until then the gate refuses
   everything, by design.
3. **Funding**: a funded test wallet + `X402_API_KEY` (dashboard, GitHub
   sign-in) for the Sepolia USDC settlement; a small CELO balance for
   deploy gas; $10–50 USDT for the one small mainnet swap.
4. **Attribution tag**: the assigned `celo_…` code from Loops registration.
   `sendTagged()` refuses to send without it — by design.
5. **Sepolia deploy**: contracts deploy + verify on Sepolia, then the
   Sepolia end-to-end job (escrow → x402 payment → accept → vault release).
6. **Mainnet swap**: one small USDT→cNGN swap for the named user's real
   obligation, only with the user's explicit approval for that amount and
   that payee. Not a test, not automated.

## Attribution caveat (found in Step 2)

Textile's `includeAttribution` tags the swap with Textile's own code, not
Ikenga's `celo_` hackathon code — whether the indexer credits a
Textile-tagged swap to Ikenga is still open. The agent's own txs
(registration, approval, cNGN payout, escrow/vault) are tagged with
Ikenga's code via `sendTagged()`; x402 settlements carry no tag today
(the facilitator submits them). Do not count x402 settlements for traction.
