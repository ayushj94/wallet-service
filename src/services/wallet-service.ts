import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../db';
import type { TransactionRow, WalletRow } from '../db/schema';
import { InsufficientBalanceError, NotFoundError, ValidationError } from '../errors';

export interface CreateWalletInput {
  customerId: string;
}

export interface MutationInput {
  walletId: string;
  amountPaise: number;
  idempotencyKey: string;
  reference?: string;
}

export interface MutationResult {
  transaction: TransactionRow;
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

export async function listTransactions(walletId: string, limit = 100): Promise<TransactionRow[]> {
  const wallet = await db.selectFrom('wallets').select('id').where('id', '=', walletId).executeTakeFirst();
  if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);

  return db
    .selectFrom('transactions')
    .selectAll()
    .where('wallet_id', '=', walletId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

export async function topup(input: MutationInput): Promise<MutationResult> {
  if (input.amountPaise <= 0) throw new ValidationError('amountPaise must be positive');
  return applyMutation('TOPUP', input);
}

export async function deduct(input: MutationInput): Promise<MutationResult> {
  if (input.amountPaise <= 0) throw new ValidationError('amountPaise must be positive');
  return applyMutation('DEDUCT', input);
}

/**
 * Core mutation path. The contract:
 *   1. Lock the wallet row (FOR UPDATE) — serializes concurrent mutations on this wallet.
 *   2. Inside the lock, check idempotency. If the key already exists, return the prior result.
 *   3. For DEDUCT, verify sufficient balance.
 *   4. Insert the ledger entry, then update wallets.balance_paise to balance_after.
 *
 * Locking BEFORE the idempotency check is what makes idempotency race-safe: two concurrent
 * requests with the same key will serialize on the wallet row, so the second one sees the
 * first one's committed transaction. The UNIQUE(wallet_id, idempotency_key) constraint is
 * a defense-in-depth backstop — would catch a bug if the lock-then-check order ever broke.
 */
async function applyMutation(
  type: 'TOPUP' | 'DEDUCT',
  input: MutationInput,
): Promise<MutationResult> {
  return db.transaction().execute(async (trx) => {
    const wallet = await trx
      .selectFrom('wallets')
      .selectAll()
      .where('id', '=', input.walletId)
      .modifyEnd(sql`FOR UPDATE`)
      .executeTakeFirst();

    if (!wallet) throw new NotFoundError(`Wallet ${input.walletId} not found`);

    const existing = await trx
      .selectFrom('transactions')
      .selectAll()
      .where('wallet_id', '=', input.walletId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirst();

    if (existing) {
      return {
        transaction: existing,
        balancePaise: wallet.balance_paise,
        idempotent: true,
      };
    }

    const signed = type === 'TOPUP' ? input.amountPaise : -input.amountPaise;
    const newBalance = wallet.balance_paise + signed;

    if (newBalance < 0) {
      throw new InsufficientBalanceError(input.walletId, wallet.balance_paise, input.amountPaise);
    }

    const txnId = randomUUID();
    await trx
      .insertInto('transactions')
      .values({
        id: txnId,
        wallet_id: input.walletId,
        type,
        amount_paise: input.amountPaise,
        balance_after_paise: newBalance,
        idempotency_key: input.idempotencyKey,
        reference: input.reference ?? null,
      })
      .execute();

    await trx
      .updateTable('wallets')
      .set({ balance_paise: newBalance })
      .where('id', '=', input.walletId)
      .execute();

    const txn = await trx
      .selectFrom('transactions')
      .selectAll()
      .where('id', '=', txnId)
      .executeTakeFirstOrThrow();

    return { transaction: txn, balancePaise: newBalance, idempotent: false };
  });
}
