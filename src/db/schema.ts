import type { Generated, Selectable } from 'kysely';

export interface WalletTable {
  id: string;
  customer_id: string;
  balance_paise: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface TransactionTable {
  id: string;
  wallet_id: string;
  type: 'TOPUP' | 'DEDUCT';
  amount_paise: number;
  balance_after_paise: number;
  idempotency_key: string;
  reference: string | null;
  created_at: Generated<Date>;
}

export interface Database {
  wallets: WalletTable;
  transactions: TransactionTable;
}

export type WalletRow = Selectable<WalletTable>;
export type TransactionRow = Selectable<TransactionTable>;
