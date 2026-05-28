import type { Generated, Selectable } from 'kysely';

export interface WalletTable {
  id: string;
  customer_id: string;
  balance_paise: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerEntryTable {
  id: string;
  wallet_id: string;
  entry_type: 'CREDIT' | 'DEBIT';
  amount_paise: number;
  balance_after_paise: number;
  idempotency_key: string;
  reference_id: string | null;
  created_at: Generated<Date>;
}

export interface Database {
  wallets: WalletTable;
  ledger_entries: LedgerEntryTable;
}

export type WalletRow = Selectable<WalletTable>;
export type LedgerEntryRow = Selectable<LedgerEntryTable>;
