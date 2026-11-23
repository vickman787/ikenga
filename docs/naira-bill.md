# Pay a naira bill

One person owes a supplier in naira. Ikenga changes USDT to cNGN on
Textile FX and pays the supplier in cNGN — only at the rate the payer
named, or better. If the rate never reaches theirs, the bill waits
until the day they picked, then pays anyway and shows exactly what the
wait cost.

This is the Stablecoin Corridors job. It is not a $1 job and it has no
escrow: the agent wallet holds the USDT, swaps it, and pays cNGN
straight to the supplier's wallet.

## The flow

1. **The payer sends the bill** — `/bills`: name, what the bill is
   for, amount in naira (smallest ₦1,500, about $1 — the corridor
   floor), the supplier's Celo wallet, the due date, and the lowest
   rate per dollar they will accept. Nothing is paid on this page.
2. **The payer funds it from their own wallet** — `/bills/[id]`: once
   the worker has previewed the rate, the page shows the exact USDT
   needed and a "Pay from my wallet" button. One tap connects their
   browser-extension wallet (the same injected-wallet pattern as the
   $1 job flow — no WalletConnect, no QR codes, no browser-generated
   wallet) and sends one plain USDT transfer to the agent wallet
   (`0x61aD7AEAC0B94C91B4681d1D8624d82d5DaF4Fc0`), tagged with
   Ikenga's tag (`celo_5144280c393f`) so the tracker counts it. The
   page says plainly what they need: USDT in their own Celo wallet
   plus a little CELO for gas, and shows the amount and the agent
   wallet address as text, so a manual transfer still works — the
   "I sent the USDT myself" form reports its hash, and the server
   checks it onchain before recording it. The transfer is verified
   onchain before the worker treats the bill as funded: the receipt
   must have succeeded, the transaction must have called the USDT
   token, from the payer's wallet, and its input must decode to
   `transfer(agentWallet, exact amount)`. A funding hash is recorded
   on one bill only — two bills can never claim the same funding.
3. **The boss worker watches it** — every 5 minutes (`ikenga-boss-worker`
   cron, `pnpm --filter @ikenga/agent boss`):
   - A free Textile preview says the rate and what the swap needs. The
     rate is what the bill actually costs, fee included
     (buyAmount / takerPays).
   - The bill is funded only by its OWN verified funding transfers —
     the recorded total must cover what the swap needs right now, and
     the agent wallet must still hold that USDT, plus a little CELO
     for gas. Short of it, the bill waits and the bill page says
     exactly how much USDT is needed and where to send it. Nothing is
     borrowed, nothing is promised.
   - Below the minimum rate and before the deadline, the worker
     refuses (the pure `decideFx` in `apps/agent/src/fx.ts`) and writes
     a receipt for what waiting saved. One refusal receipt per bill,
     not one every five minutes.
   - At or above the minimum — or at the deadline — a firm quote is
     requested and `decideFx` makes the call. A refused firm quote is
     cancelled, so the maker's slot is freed.
   - The swap runs through `executeSwap` (`packages/payments/src/textile.ts`).
   - The cNGN payout goes to the supplier straight after, in the same
     run when the cNGN is there. Every step is resumable: a swap with
     no payout yet is picked up by the next run.
3. **The bill page shows where it stands** — `/bills/[id]`: the rate
   seen vs the minimum, the funding needed, the swap and payout
   transactions on Celoscan, and the hash-chained receipts. While the
   bill waits, the page says so. No numbers are invented.

## The funding rule (read this before touching funding)

A bill is funded when the sum of its verified funding payments (atomic
USDT, recorded per transfer) is at least the USDT the swap needs at
swap time — the current preview's `takerPays`, not the amount shown
when the friend first opened the page.

- The friend pays the amount shown on the bill page, which is the
  latest preview's need. If the rate moves after they pay so the swap
  needs more, the bill waits and the page shows the shortfall; the
  friend can pay the difference in a second transfer, which is
  verified and added to the same bill.
- If the rate moves the other way and the swap needs less than was
  paid, the swap goes ahead and the extra stays in the agent wallet.
  It is not refunded automatically.
- The worker also requires the agent wallet to still hold at least the
  needed USDT at swap time: the money must actually be there, not
  just recorded. If another bill's swap spent it first, this bill
  waits and says so.
- One funding hash is recorded on one bill only. A hash already on
  another bill is refused; re-reporting the same hash on the same
  bill is a no-op. The first funding sets the bill's payer wallet;
  later fundings for the same bill must come from that wallet.

## Tagging (read this before touching the swap)

- The USDT approval before the swap goes through `sendTagged` — it
  carries Ikenga's tag (`celo_5144280c393f`).
- The swap itself is broadcast **exactly as Textile returns it** — do
  NOT append our tag to the swap calldata. The swap already carries
  Textile's tag, and the indexer reads only the last tag: re-tagging
  would lose one of the two. Whether the hackathon indexer credits a
  Textile-tagged swap to Ikenga is still open (risk R-5 in
  `docs/step2-plan.md`).
- The cNGN payout from the agent wallet to the supplier goes through
  `sendTagged`, so it carries Ikenga's tag. That is the transaction
  the tracker counts as Ikenga paying a real person in cNGN.
- The friend's funding transfer is tagged in the browser
  (`fundBillTransfer` in `apps/web/src/lib/contracts.ts`, same
  `tagCalldata` pattern as the $1 job flow — encode, append, send;
  fail-open with a console warning if the tag is missing, so a
  payment is never blocked by tagging). The server verifies the
  transfer onchain before recording it
  (`verifyFundingTransfer` in `packages/payments/src/escrow.ts`:
  receipt succeeded, called USDT, from the payer's wallet, input
  decodes to `transfer(agentWallet, exact amount)` after the tag is
  stripped).
- The split is enforced in code: `makeBillSendFn` in
  `apps/agent/src/bills.ts` tags everything except the exact swap
  calldata, and `apps/agent/src/bills.test.ts` proves it byte for byte
  (approval tagged, swap byte-identical to Textile's, payout tagged
  and still the same transfer underneath).

## What still needs a real bill

- A named person with a real bill (₦1,500 or more), the five answers,
  and the USDT for it — they pay from their own wallet on the bill
  page (see the funding step above). No one else funds it for them.
- A redeploy of the site: the bills code ships in the repo, but the
  live site serves `/api/bills` only after the next Production deploy
  (which needs the Vercel identity code). Until then the worker logs
  "the site doesn't serve /api/bills yet" and skips the bill pass
  instead of failing.
- There is no Celo testnet corridor, so the swap cannot be tested on
  Sepolia. The first live swap is a real mainnet swap for a real bill,
  with real USDT — it needs the user's go-ahead for that exact bill.

## Where the code lives

- `packages/ledger/src/index.ts` + `schema.sql` — `bills` and
  `bill_events` (hash-chained receipts), Memory + Postgres.
- `apps/web/src/lib/bills.ts` — validation (zod), create/read/update.
- `apps/web/src/app/api/bills/` — list/create, one bill + receipts,
  the worker's update endpoint (checks swap/payout hashes onchain
  before recording them).
- `apps/web/src/app/bills/` — the form and the bill page.
- `apps/agent/src/bills.ts` — the pipeline (preview → funding →
  firm quote → decide → swap → payout), plus the pure rate/payout
  helpers.
- `apps/agent/src/boss-worker.ts` — pass 3 wires the real clients
  around the pipeline. Mainnet only.
