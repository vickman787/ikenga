# Paying for a $1 job in cNGN

A job is $1. The customer can pay it in USDT — or in naira (cNGN) at
the live rate. This page explains how the cNGN leg works, what is live,
and what still needs doing.

## The price is fixed at hire time

cNGN moves against the dollar, so a job's cNGN price is fixed when the
job is hired, never re-derived later:

1. The hire form shows the live amount from `GET /api/quote?currency=cNGN`
   — a Textile FX preview of selling exactly $1 of USDT for cNGN.
2. At hire time the server fetches the preview again and fixes the price
   with `cngnJobPrice` (`packages/payments/src/pricing.ts`): the preview's
   buy amount, rounded **up** to whole cNGN. At ~1,444.067 cNGN per $1 that
   is 1,445,000,000 atomic cNGN.
3. The price (`priceAtomic`), the rate it was fixed at (`priceRate`), the
   token and the vault are stored on the job record (`orders` table:
   `pay_currency`, `price_atomic`, `price_rate`, `token_address`,
   `vault_address`). A rate move after hire never changes a hired job.
4. The customer pays exactly `priceAtomic` cNGN into the job's escrow.
   The escrow, fund and decision routes verify the escrow's token, vault
   and onchain `price()` against the job record — not against the chain
   defaults — so a USDT escrow can never satisfy a cNGN job, and a
   short payment is refused before the team starts.

The hire form shows the live amount and the fixed rate in plain words.
`GET /api/chain` returns both tokens and both vaults (`payTokens`,
`tokens`, `vaults`); Sepolia offers test USDC only — there is no cNGN
on Sepolia.

## Two vaults, never mixed

`IkengaVault` is token-agnostic (the token is a constructor argument),
so each currency gets its own vault instance — no contract change was
needed:

- USDT vault (live): `0x1C2b2E64527B0bA7795ed3CDF7d76da51D24018B` — holds
  the real $1 from the first accepted job.
- cNGN vault: **not deployed yet.** Deploy it with
  `contracts/script/DeployCngnVault.s.sol` (deploys `IkengaVault(boss,
  CNGN)` only), then set `IKENGA_CNGN_VAULT_ADDRESS` in Vercel
  Production and redeploy. Until then `GET /api/vault` shows the cNGN
  slot honestly (`vaultAddress: null`, zero balances) and the hire form
  disables cNGN with "Paying in naira is not switched on yet".

Changing the USDT vault's code instead would have meant a redeploy, a
migration of the $1 already in it, and re-registering its escrows — for
no benefit. Two vaults keep each currency's books separate, and cNGN is
**never silently converted to USDT on accept**: it lands in the cNGN
vault's OPERATING pot and stays cNGN. `GET /api/vault` returns both
vaults (top-level fields stay the USDT vault for the landing).

## The escrow price is a constructor argument

`JobEscrow` used to hardcode `PRICE = 1_000_000`. A cNGN job needs
~1,445,000,000, so the price is now a constructor argument
(`_price`, after `_bondAmount`), stored as `immutable price` and read
back with `price()`. Fund / accept / reject / deadlineRelease all move
exactly `price`. Old escrows (including the live $1 job's) have no
`price()` — `readEscrowOnchain` reports it as null and callers fall
back to the job record.

## The boss worker resolves the vault per escrow

`registerEscrow` and `submitDeliverable` are boss-only on the vault,
and the boss worker runs them. It never assumes which vault: it reads
`ikengaVault()` from the escrow itself, checks the boss of *that*
vault, and registers/seals there. A cNGN escrow registers and seals in
the cNGN vault; a USDT escrow in the USDT vault.

## What the customer signs

Deploy, approve, fund, accept and reject are all sent from the
customer's own browser wallet via `tagCalldata` / `sendTaggedCall`
(`apps/web/src/lib/contracts.ts`) — every one carries Ikenga's
attribution tag, exactly as the USDT flow does. The pay panel checks
the wallet holds enough of the job's token before deploying anything,
so a short wallet never wastes the deploy fee.

## Agent costs stay in USDT

Only the customer's payment currency changes. The CFO's budgets — the
$0.50 report cap, the 30 USDT weekly tool budget, the 5 USDT per-move
max — stay USDT-denominated. Decisions record the payment currency
(`decision_log.currency`, and the currency in the hash-chained entry
text).

## Proof so far

- Forge: `JobEscrow.t.sol` has 4 cNGN tests (fund + accept at the
  cNGN price, reject refunds the full price, USDT + cNGN escrows side
  by side, zero price reverts).
- `packages/payments/src/pricing.test.ts`: rounding up, whole amounts,
  rate-move immutability, bad-input refusal.
- Web: hire-time price fixing (incl. a rate move between hires),
  cNGN refused without a vault and on Sepolia, escrow/fund routes
  verified against the job's own price, deploy encoding with the cNGN
  token + price.
- Sepolia: `apps/agent/src/e2e-multitoken-sepolia.ts` (`pnpm
  --filter @ikenga/agent exec:multitoken-sepolia`, gated by
  `IKENGA_LIVE_TESTS=1`) deploys a mock second token + a second vault,
  runs a job at 1,445,000,000 through the exact browser sequence
  (all customer txs tagged), and proves the mock lands in the second
  vault's OPERATING pot while the first vault does not move. There is
  no cNGN on Sepolia, so the mock stands in for it.

## Still to do (needs a real customer + go-ahead)

1. Deploy the cNGN vault on mainnet (one Foundry broadcast, gas only,
   ~3.5M gas ≈ 0.7 CELO at 200 gwei).
2. Set `IKENGA_CNGN_VAULT_ADDRESS` in Vercel Production, redeploy
   (needs the user's Vercel identity code).
3. A real customer pays a $1 job in cNGN from their own wallet and the
   boss worker seals it — the first live cNGN job.
