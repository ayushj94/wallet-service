-- Wallets: one row per customer. balance_paise stored as BIGINT to avoid float drift.
CREATE TABLE IF NOT EXISTS wallets (
  id              CHAR(36)     NOT NULL PRIMARY KEY,
  customer_id     VARCHAR(64)  NOT NULL,
  balance_paise   BIGINT       NOT NULL DEFAULT 0,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_customer (customer_id),
  CONSTRAINT chk_balance_non_negative CHECK (balance_paise >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ledger entries: append-only double-entry ledger. Each row is one money
-- movement (CREDIT into the wallet or DEBIT out). balance_after_paise snapshot
-- lets us verify SUM(signed amounts) == wallets.balance_paise without replaying.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id                    CHAR(36)              NOT NULL PRIMARY KEY,
  wallet_id             CHAR(36)              NOT NULL,
  entry_type            ENUM('CREDIT','DEBIT') NOT NULL,
  amount_paise          BIGINT                NOT NULL,
  balance_after_paise   BIGINT                NOT NULL,
  idempotency_key       VARCHAR(128)          NOT NULL,
  reference_id          VARCHAR(128)          NULL,
  created_at            TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE KEY uniq_wallet_idem (wallet_id, idempotency_key),
  KEY idx_wallet_created (wallet_id, created_at),
  CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  CONSTRAINT chk_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT chk_balance_after_non_negative CHECK (balance_after_paise >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
