import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../db';
import type { LedgerEntryRow, WalletRow } from '../db/schema';
import { InsufficientBalanceError, NotFoundError, ValidationError } from '../errors';

export interface CreateWalletInput {
  customerId: string;
}

export interface LedgerOperationInput {
  walletId: string;
  amountPaise: number;
  idempotencyKey: string;
  referenceId?: string;
}

export interface LedgerOperationResult {
  entry: LedgerEntryRow;
  balancePaise: number;
  idempotent: boolean;
}

export async function createWallet(input: CreateWalletInput): Promise<WalletRow> {
  const id = randomUUID();
  await db.insertInto('wallets').values({ id, customer_id: input.customerId, balance_paise: 0 }).execute();
  const row = await db.selectFrom('wallets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  return row;
}

export async function getBalance(walletId: string): Promise<{ walletId: string; balancePaise: number }> {
  const row = await db
    .selectFrom('wallets')
    .select(['id', 'balance_paise'])
    .where('id', '=', walletId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError(`Wallet ${walletId} not found`);
  return { walletId: row.id, balancePaise: row.balance_paise };
}

export async function listLedgerEntries(walletId: string, limit = 100): Promise<LedgerEntryRow[]> {
  const wallet = await db.selectFrom('wallets').select('id').where('id', '=', walletId).executeTakeFirst();
  if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);

  return db
    .selectFrom('ledger_entries')
    .selectAll()
    .where('wallet_id', '=', walletId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

export async function topup(input: LedgerOperationInput): Promise<LedgerOperationResult> {
  if (input.amountPaise <= 0) throw new ValidationError('amountPaise must be positive');
  return recordLedgerEntry('CREDIT', input);
}

export async function deduct(input: LedgerOperationInput): Promise<LedgerOperationResult> {
  if (input.amountPaise <= 0) throw new ValidationError('amountPaise must be positive');
  return recordLedgerEntry('DEBIT', input);
}

/**
 * Core mutation path for the customer wallet. Contract:
 *   1. Lock the wallet row (FOR UPDATE) — serializes concurrent operations on this wallet.
 *   2. Inside the lock, check idempotency. If the key already exists, return the prior result.
 *   3. For DEBIT, verify sufficient balance.
 *   4. Insert the ledger entry, then update wallets.balance_paise to balance_after.
 *
 * Locking BEFORE the idempotency check is what makes idempotency race-safe: two concurrent
 * requests with the same key serialize on the wallet row, so the second one sees the first
 * one's committed entry. The UNIQUE(wallet_id, idempotency_key) constraint is a
 * defense-in-depth backstop — it would catch a bug if the lock-then-check order ever broke.
 */
async function recordLedgerEntry(
  entryType: 'CREDIT' | 'DEBIT',
  input: LedgerOperationInput,
): Promise<LedgerOperationResult> {
  return db.transaction().execute(async (trx) => {
    const wallet = await trx
      .selectFrom('wallets')
      .selectAll()
      .where('id', '=', input.walletId)
      .modifyEnd(sql`FOR UPDATE`)
      .executeTakeFirst();

    if (!wallet) throw new NotFoundError(`Wallet ${input.walletId} not found`);

    const existing = await trx
      .selectFrom('ledger_entries')
      .selectAll()
      .where('wallet_id', '=', input.walletId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();

    if (existing) {
      return { entry: existing, balancePaise: wallet.balance_paise, idempotent: true };
    }

    const signed = entryType === 'CREDIT' ? input.amountPaise : -input.amountPaise;
    const newBalance = wallet.balance_paise + signed;

    if (newBalance < 0) {
      throw new InsufficientBalanceError(input.walletId, wallet.balance_paise, input.amountPaise);
    }

    const entryId = randomUUID();
    await trx
      .insertInto('ledger_entries')
      .values({
        id: entryId,
        wallet_id: input.walletId,
        entry_type: entryType,
        amount_paise: input.amountPaise,
        balance_after_paise: newBalance,
        idempotency_key: input.idempotencyKey,
        reference_id: input.referenceId ?? null,
      })
      .execute();

    await trx
      .updateTable('wallets')
      .set({ balance_paise: newBalance })
      .where('id', '=', input.walletId)
      .execute();

    const entry = await trx
      .selectFrom('ledger_entries')
      .selectAll()
      .where('id', '=', entryId)
      .executeTakeFirstOrThrow();

    return { entry, balancePaise: newBalance, idempotent: false };
  });
}
