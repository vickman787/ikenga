# tests/

Package-level tests live next to their source (`src/*.test.ts`) and run with
`pnpm -r test` from the repo root, or per package with `pnpm --filter <pkg> test`.

- `packages/shared` — CFO pricing pure function (deterministic, no model).
- `packages/ledger` — hash chain, MemoryLedger, PostgresLedger (pg-mem).
- `packages/payments` — Celo constants, payment-request validation, stubs.
- `apps/agent` — `decide()` (CFO + Self gate).
- `apps/web` — hire-flow validation and order creation.

Contracts have Foundry smoke tests in `contracts/test/` (`forge test`,
requires Foundry — not installed in this VM in Step 1).
