import type { Generated, Selectable } from 'kysely';

export type Currency = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'INR';

export interface WalletTable {
  id: string;
  customer_id: string;
  currency: Currency;
  balance: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface WalletLedgerEntryTable {
  id: string;
  wallet_id: string;
  entry_type: 'CREDIT' | 'DEBIT';
  amount: number;
  balance_after: number;
  reference_type: string;
  reference_id: string;
  created_at: Generated<Date>;
}

export interface Database {
  wallets: WalletTable;
  wallet_ledger_entries: WalletLedgerEntryTable;
}

export type WalletRow = Selectable<WalletTable>;
export type WalletLedgerEntryRow = Selectable<WalletLedgerEntryTable>;
