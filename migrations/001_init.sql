-- A wallet holds money for one customer in one currency. balance is the running
-- total. Every successful credit/debit updates it inside the same transaction
-- that records the corresponding ledger entry, so they can never drift.
--
-- Amounts are stored as integers in the smallest unit of the currency
-- (cents for USD/EUR/GBP/CAD, paise for INR). This is the standard fintech
-- convention (Stripe, Razorpay, Adyen all work this way). Integer math is
-- exact, JSON-safe, and avoids floating-point drift.

CREATE TABLE IF NOT EXISTS wallets (
  id              UUID         NOT NULL PRIMARY KEY,
  customer_id     VARCHAR(64)  NOT NULL UNIQUE,
  currency        CHAR(3)      NOT NULL,
  balance         BIGINT       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT chk_currency_known CHECK (currency IN ('USD','EUR','GBP','CAD','INR'))
);

-- The ledger is an append-only record of every money movement for a wallet.
-- balance_after snapshots the wallet balance immediately after this entry
-- was applied. Keeps history auditable without replaying logic.
--
-- (reference_type, reference_id) identifies the upstream business event that
-- caused this entry. The unique constraint on (wallet_id, reference_type,
-- reference_id) is what makes retries safe: the source system reuses the same
-- instruction ID on a retry, the database catches the duplicate, we return
-- the existing entry instead of writing a new one.

DO $$ BEGIN
  CREATE TYPE entry_type_enum AS ENUM ('CREDIT', 'DEBIT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
  id                UUID                NOT NULL PRIMARY KEY,
  wallet_id         UUID                NOT NULL REFERENCES wallets(id),
  entry_type        entry_type_enum     NOT NULL,
  amount            BIGINT              NOT NULL,
  balance_after     BIGINT              NOT NULL,
  reference_type    VARCHAR(32)         NOT NULL,
  reference_id      VARCHAR(128)        NOT NULL,
  created_at        TIMESTAMPTZ         NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uniq_wallet_ref UNIQUE (wallet_id, reference_type, reference_id),
  CONSTRAINT chk_amount_positive CHECK (amount > 0),
  CONSTRAINT chk_balance_after_non_negative CHECK (balance_after >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet_created
  ON wallet_ledger_entries (wallet_id, created_at DESC);
