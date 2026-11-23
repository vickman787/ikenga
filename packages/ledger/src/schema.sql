-- Ikenga ledger schema (PostgreSQL 16).
-- Step 1: schema only. No real money is recorded here yet; orders are
-- demo records and decisions are the hash-chained CFO audit log design.
-- All money is integer minor units (micro-USDC, 6 decimals) — never floats.

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('website', 'promo-video', 'flyers', 'market-report')),
  customer_wallet TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'escrowed', 'in-progress', 'delivered', 'accepted', 'rejected', 'refunded')),
  price_micro_usdc BIGINT NOT NULL DEFAULT 1000000,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hire fields that used to live only in server memory (Step 3 fix: a hire
-- on one serverless instance must be visible to the next). Added with
-- IF NOT EXISTS so old databases pick them up on init.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bond_micro_usdc BIGINT NOT NULL DEFAULT 100000;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cfo_accepted BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cfo_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS decision_hash TEXT NOT NULL DEFAULT '';
-- Escrow fields: each job deploys its own JobEscrow from the customer's
-- browser, and the $1 moves only through it. Same IF NOT EXISTS pattern,
-- so old databases pick them up on init.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS escrow_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fund_tx_hash TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deliverable_tx_hash TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settle_tx_hash TEXT;
-- What a job is paid in: USDT on mainnet, test USDC on Sepolia, cNGN
-- on mainnet. The price is fixed at hire time in that currency's atomic
-- units, with the live cNGN rate recorded alongside it. Same IF NOT
-- EXISTS pattern, so old databases pick them up on init.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pay_currency TEXT NOT NULL DEFAULT 'USDT';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_atomic TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS price_rate TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS token_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS vault_address TEXT;

CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('quote', 'escrow', 'top-up', 'accept', 'reject', 'refund', 'refuse',
                    'fx-quote', 'fx-swap', 'fx-refuse', 'self-verify', 'self-refuse', 'x402-settle')),
  reason TEXT NOT NULL,
  amount_micro_usdc BIGINT NOT NULL DEFAULT 0,
  -- Which currency the money in this decision is in (USDT by default).
  -- The amount stays in micro-USDC for the CFO's $1 maths; the currency
  -- says what the customer actually paid.
  currency TEXT NOT NULL DEFAULT 'USDT',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  -- Step 2: full entry text the hash covers (plan §2.5). Without it,
  -- Postgres chain verification recomputes from kind|reason|amount only.
  entry_text TEXT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_log_order_idx ON decision_log (order_id, created_at);
CREATE INDEX IF NOT EXISTS decision_log_hash_idx ON decision_log (hash);
-- Currency of each decision's money (added with the cNGN jobs).
ALTER TABLE decision_log ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USDT';

-- Step 2: Textile FX swaps (plan §2.2). The claim token is NOT stored here:
-- it lives in server memory for the life of the RFQ only (risk R-8).
CREATE TABLE IF NOT EXISTS fx_swaps (
  rfq_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  chain_id BIGINT NOT NULL,
  sell_token TEXT NOT NULL,
  buy_token TEXT NOT NULL,
  sell_amount TEXT NOT NULL,
  buy_amount TEXT NOT NULL,
  taker_pays TEXT NOT NULL,
  fee_amount TEXT NOT NULL,
  rate_ray TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  order_deadline TIMESTAMPTZ NOT NULL,
  reactor TEXT NOT NULL,
  approval_tx_hash TEXT,
  swap_tx_hash TEXT,
  forced BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'quoted'
    CHECK (status IN ('quoted', 'submitted', 'filled', 'no_quote', 'expired', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 2: Self Agent ID verification checks (plan §2.3).
-- No nullifier column — by design, never stored.
CREATE TABLE IF NOT EXISTS self_verifications (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  agent_address TEXT NOT NULL,
  verified BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 2: x402 payments (plan §2.5). A payment is "settled" only with a tx hash.
CREATE TABLE IF NOT EXISTS x402_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  agent_id TEXT,
  asset TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('verified', 'settled', 'failed', 'ambiguous')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Step 3: delivered work + in-progress report state. One row per order.
-- `data` is the whole report as JSON (report text, sources, steps, totals,
-- status, and — while the job is running — which stage is next and the
-- pages/plan/draft gathered so far, so the next stage can pick up where
-- the last one stopped, even on another serverless instance). `status` and
-- `stage` are pulled out as columns so they can be read without parsing.
CREATE TABLE IF NOT EXISTS deliveries (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'in-progress'
    CHECK (status IN ('in-progress', 'delivered', 'refused')),
  stage INT NOT NULL DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Naira bills (Corridors track). One person owes a supplier in naira; the
-- agent wallet changes USDT to cNGN on Textile FX and pays the supplier in
-- cNGN. No escrow: the swap and the payout are agent-wallet transactions
-- (the payout carries Ikenga's tag; the swap carries Textile's — risk R-5).
-- Amounts are whole naira; rates are cNGN per 1 USDT, fee included
-- (buyAmount / takerPays). The worker updates the row as it watches the
-- rate, waits for funding, swaps, and pays.
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  payer_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount_ngn BIGINT NOT NULL CHECK (amount_ngn >= 1500),
  supplier_wallet TEXT NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  min_rate DOUBLE PRECISION NOT NULL CHECK (min_rate > 0),
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'watching', 'converting', 'paid', 'failed')),
  note TEXT,
  last_checked_at TIMESTAMPTZ,
  last_rate DOUBLE PRECISION,
  last_rate_at TIMESTAMPTZ,
  last_decision TEXT CHECK (last_decision IS NULL OR last_decision IN ('convert', 'refuse', 'force-convert', 'wait')),
  last_decision_reason TEXT,
  last_bps_gap INT,
  last_naira_saved BIGINT,
  funding_needed_usdt TEXT,
  funding_ready BOOLEAN,
  funding_payer_wallet TEXT,
  funding_tx_hashes TEXT NOT NULL DEFAULT '[]',
  funding_paid_usdt_atomic TEXT,
  rfq_id TEXT,
  approval_tx_hashes TEXT NOT NULL DEFAULT '[]',
  swap_tx_hash TEXT,
  forced BOOLEAN NOT NULL DEFAULT FALSE,
  payout_tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Funding for a bill is paid by the friend from their own wallet, not
-- by the user: one verified USDT transfer per funding record. A funding
-- tx hash is recorded on one bill only, so two bills can never claim the
-- same funding; the paid total is atomic USDT across the bill's funding
-- transfers. Added with IF NOT EXISTS so old databases pick them up on init.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS funding_payer_wallet TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS funding_tx_hashes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS funding_paid_usdt_atomic TEXT;

-- One hash-chained receipt per bill event — the same chaining as the CFO
-- decision log, so a bill's history can't be rewritten silently.
CREATE TABLE IF NOT EXISTS bill_events (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('created', 'quote', 'refuse', 'convert', 'swap', 'payout', 'paid', 'failed', 'waiting', 'funded')),
  reason TEXT NOT NULL,
  rate_seen DOUBLE PRECISION,
  bps_gap INT,
  tx_hash TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  entry_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bill_events_bill_idx ON bill_events (bill_id, created_at);
