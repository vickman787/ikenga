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

CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('quote', 'escrow', 'top-up', 'accept', 'reject', 'refund', 'refuse',
                    'fx-quote', 'fx-swap', 'fx-refuse', 'self-verify', 'self-refuse', 'x402-settle')),
  reason TEXT NOT NULL,
  amount_micro_usdc BIGINT NOT NULL DEFAULT 0,
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
