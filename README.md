# Ikenga

**Agents do the work. The CFO runs the money.**

Ikenga is a company staffed by AI agents that does $1 jobs for Nigerian small
businesses — websites, promo videos, flyers, market reports — rebuilt for
Celo. A customer pays $1 into escrow and pays only if they accept the work;
rejection refunds the price plus a bond the CFO put up. An AI CFO prices
jobs, funds agents and signs every decision. **No language model touches
money.** Agents pay for their own tools per call via x402, and every CFO
decision is hash-chained and signed in a public audit log.

Built for the Celo **"Agents Open for Business"** hackathon (Nov 20 – Dec 7,
2026), tracks:

- **Track 1 — Stablecoin Corridors ($2,000):** the naira leg converts
  USDT ↔ cNGN on Textile FX (Celo mainnet).
- **Track 3 — Self Agent ID ($1,000):** the CFO serves or pays an agent only
  after its Self Agent ID is verified.

## What Ikenga is

Ikenga is a fresh implementation built for Celo: $1 jobs, an AI CFO, escrow
and a signed audit log, with the naira leg on Textile FX USDT↔cNGN, Celo's
x402 facilitator, and a Self Agent ID gate before any agent is served or
paid.

## Step 2 status — money paths are real, live proof is blocked on the user

Step 2 is done (2026-11-21). Verified: **132 TypeScript tests pass (9 skipped,
all live-gated) + 48 Foundry tests pass**, typechecks + web build pass,
production server 200 with `/api/cfo`, `/api/traction`, `/api/jobs/[id]` live.

- ✅ Real contracts: `JobEscrow` (fund 1 USDT, accept → vault, reject → refund
  + bond, 48 h deadline release) and `IkengaVault` (buckets, maxMove 5 USDT,
  per-agent allowances, bond cover, propose/coSign, no arbitrary payouts).
  Not deployed, not audited. Forge 1.10.0.
- ✅ Real x402 via the Celo facilitator (verify/settle, buyer client with
  spend controls, `sendTagged()` chokepoint: CIP-64 feeCurrency + ERC-8021
  attribution). Retry header resolved: `PAYMENT-SIGNATURE` (v2).
- ✅ Real Textile FX RFQ client (preview/levels/firm quote/submit/cancel/
  executeSwap). Live read-only check: Celo USDT→cNGN, min $1, max ≈ $42,442;
  $10 preview → 14,440.67 cNGN (~₦1,444/USDT). No live swap has run.
- ✅ Real Self Agent ID gate (`@selfxyz/agent-sdk` 0.3.1, SDK lookup + direct
  registry read, sybil check, nullifier never returned/stored). Live Sepolia
  registry read verified. No agent is registered yet.
- ✅ ERC-8004 registries verified read-only; registration script ready, not run.
- ✅ Ledger stores full entry text and verifies from it; `reconcile()` settles
  only with a tx hash. Agent loop is real (price → Self gate → work → x402
  → FX leg → cNGN payout).
- ✅ **All four jobs are real now.** The market report (Scout searches
  the web for free — Bing first, Wikipedia backup — Researcher plans,
  Writer writes, Analyst checks the numbers, all on OpenAI's gpt-4o-mini,
  then the Auditor reads it on a different model,
  gpt-4o, in two short calls — facts first, then a final
  read) plus the website and flyers (Designer builds a real page
  from the brief, Analyst checks every word and price against it,
  Auditor reads it) and the promo video (Producer puts a motion
  slideshow together — moving slides, honestly labelled, not a video
  file). A real job costs about $0.01–0.02 (sample report: 16,696
  tokens, $0.0097, 0 revisions, Auditor passed first time). The job
  page shows who did what, the delivered work, and accept / one free
  revision / turn it down. The website and flyer pages are shown in a
  sandboxed frame with scripts switched off. See
  `docs/market-report.md`. Needs `OPENAI_API_KEY` on the server.
- 🛑 **Blocked — needs the user:** named real user + obligation; Self
  registration (human QR scan + passport/ID); funded test wallet +
  `X402_API_KEY`; attribution tag from Loops registration; Sepolia deploy.
  Run `pnpm --filter @ikenga/agent exec:sepolia` — it prints the blocked list
  (2/6 pass today). No mainnet funds have moved; no mainnet swap runs without
  the user's explicit approval for that amount and payee.
- ⚠️ Attribution caveat: Textile tags swaps with its own code, not Ikenga's
  `celo_` code — whether the indexer credits those swaps to Ikenga is open.
  The agent's own txs are tagged via `sendTagged()`; x402 settlements carry
  no tag today. See `docs/judge-path.md` and `docs/step2-plan.md`.

## Run it

```bash
pnpm install
pnpm --filter @ikenga/web dev   # http://localhost:3000
```

Local Postgres (optional — the app uses the in-memory ledger when DATABASE_URL is unset):

```bash
docker compose up -d postgres   # port 5433
```

Tests, typechecks, contracts, Sepolia proof checklist:

```bash
pnpm -r test
pnpm typecheck
pnpm --filter @ikenga/web build
forge test   # from contracts/
pnpm --filter @ikenga/agent exec:sepolia   # gated: prints what is blocked
```

## Layout

```
apps/web/        Next.js 16 / React 19 / Tailwind — landing + hire flow, /api/cfo, /api/traction, /api/jobs/[id]
apps/agent/      Agent runner (pure decide()/decideFx(), real loop, Sepolia E2E checklist script)
packages/shared/ Types, Zod schemas, CFO pricing, FX + Self schemas
packages/ledger/ Postgres schema, Memory/Postgres ledgers, hash chain, reconciliation
packages/payments/ Celo x402 (real), Textile FX RFQ (real), Self gate (real), sendTagged()
contracts/       Foundry — real JobEscrow + IkengaVault, 48 tests, deploy + ERC-8004 scripts
docs/            spec.md, architecture.md, judge-path.md, step2-plan.md
```

## Security

See `SECURITY.md`. No private keys or secrets are in this repo or generated
by it. `.env` is gitignored; only `.env.example` (no secrets) is committed.
