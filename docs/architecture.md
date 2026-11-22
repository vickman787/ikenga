# Ikenga — architecture (Step 1)

Monorepo (pnpm workspaces), mirroring the proven Coven layout:

```
ikenga/
  apps/web/        Next.js 16 / React 19 / Tailwind — landing + Hire Ikenga
  apps/agent/      Agent runner skeleton — decide() is pure, runJob() records
  packages/shared/ Types, Zod schemas, deterministic CFO pricing (priceJob)
  packages/ledger/ Postgres schema + MemoryLedger + PostgresLedger, sha256 chain
  packages/payments/ Celo constants, x402 client stub, Self Agent ID gate stub
  contracts/       Foundry skeleton — JobEscrow + IkengaVault (placeholders)
  docs/            spec.md, architecture.md, judge-path.md
```

## Data flow (target, Step 2+)

```
customer wallet ──$1──> JobEscrow (Celo mainnet)
                          │ accept / 48h silence
                          ▼
                    IkengaVault (OPERATING → TOOLS / BOND / RESERVE)
                          │ CFO tops up agents within allowance
                          ▼
                    agents pay tools per call via x402 (api.x402.celo.org)
                          │ naira leg: Textile FX RFQ USDT → cNGN
                          ▼
                    cNGN → named supplier wallet (tagged, ERC-8021)
                          │
                    every decision → hash-chained, signed audit log
```

## Money rules

- All money is integer micro-USDC/USDT (6 decimals). Never floats.
- One chokepoint sends transactions; it attaches the CIP-64 fee currency
  and the ERC-8021 attribution suffix. (Step 2.)
- The CFO's limits live in code and, in Step 2, on-chain: maxMove per step,
  weekly tool budget, bond cover, reserve floor. Anything bigger is a
  proposal the human owner co-signs.

## Storage

- Postgres 16 (docker-compose, port 5433) for orders + decision log.
- `MemoryLedger` is the dev/demo fallback; the web hire flow uses it in
  Step 1. No mock data is ever presented as real: demo records are labelled.
