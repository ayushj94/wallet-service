-- A wallet has one row per customer. balance_paise is the running total — every
-- successful credit/debit updates it inside the same transaction that records the
-- corresponding ledger entry, so they can never drift.

CREATE TABLE IF NOT EXISTS wallets (
  id              UUID         NOT NULL PRIMARY KEY,
  customer_id     VARCHAR(64)  NOT NULL UNIQUE,
  balance_paise   BIGINT       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_balance_non_negative CHECK (balance_paise >= 0)
);

-- The ledger is an append-only record of every money movement. balance_after_paise
-- snapshots the wallet balance immediately after this entry was applied, so the
-- whole history is auditable without replaying logic.

DO $$ BEGIN
  CREATE TYPE entry_type_enum AS ENUM ('CREDIT', 'DEBIT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                    UUID                NOT NULL PRIMARY KEY,
  wallet_id             UUID                NOT NULL REFERENCES wallets(id),
  entry_type            entry_type_enum     NOT NULL,
  amount_paise          BIGINT              NOT NULL,
  balance_after_paise   BIGINT              NOT NULL,
  idempotency_key       VARCHAR(128)        NOT NULL,
  reference_id          VARCHAR(128),
  created_at            TIMESTAMPTZ         NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uniq_wallet_idem UNIQUE (wallet_id, idempotency_key),
  CONSTRAINT chk_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT chk_balance_after_non_negative CHECK (balance_after_paise >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_wallet_created
  ON ledger_entries (wallet_id, created_at DESC);
