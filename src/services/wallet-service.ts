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
  return db.selectFrom('wallets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
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
 * The heart of the service. Records a credit or debit using Postgres' optimistic
 * concurrency pattern.
 *
 * The flow:
 *   1. Fast path — have we already processed this idempotency key? If yes,
 *      return the stored result immediately. Cheap single SELECT.
 *   2. Slow path — open a transaction and:
 *      a. Conditionally update the wallet balance with `RETURNING`. The WHERE
 *         clause refuses the update if the resulting balance would be negative,
 *         so insufficient-balance is detected atomically with the mutation.
 *      b. Insert a ledger entry. If a concurrent request just committed an
 *         entry with the same idempotency key, ON CONFLICT DO NOTHING returns
 *         no row — we throw, the transaction rolls back (which undoes step a),
 *         and the outer catch fetches the winning entry.
 *
 * Why this works: between any two requests, Postgres' row-level lock on the
 * wallet row (acquired inside UPDATE) makes step 2a serial. The UNIQUE
 * constraint on (wallet_id, idempotency_key) makes step 2b race-safe.
 */
class IdempotencyRace extends Error {}

async function recordLedgerEntry(
  entryType: 'CREDIT' | 'DEBIT',
  input: LedgerOperationInput,
): Promise<LedgerOperationResult> {
  // 1. Fast path: already processed?
  const cached = await db
    .selectFrom('ledger_entries')
    .selectAll()
    .where('wallet_id', '=', input.walletId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();

  if (cached) {
    const wallet = await db
      .selectFrom('wallets')
      .select('balance_paise')
      .where('id', '=', input.walletId)
      .executeTakeFirst();
    if (!wallet) throw new NotFoundError(`Wallet ${input.walletId} not found`);
    return { entry: cached, balancePaise: wallet.balance_paise, idempotent: true };
  }

  // 2. Slow path: try to record it.
  try {
    return await db.transaction().execute(async (trx) => {
      const signed = entryType === 'CREDIT' ? input.amountPaise : -input.amountPaise;

      // Conditional update — moves balance only if the new value would be non-negative.
      const updated = await trx
        .updateTable('wallets')
        .set({ balance_paise: sql<number>`balance_paise + ${signed}` })
        .where('id', '=', input.walletId)
        .where(sql<boolean>`balance_paise + ${signed} >= 0`)
        .returning('balance_paise')
        .executeTakeFirst();

      if (!updated) {
        // Either the wallet doesn't exist, or the balance check failed. Look up
        // which case to give a precise error.
        const wallet = await trx
          .selectFrom('wallets')
          .select('balance_paise')
          .where('id', '=', input.walletId)
          .executeTakeFirst();
        if (!wallet) throw new NotFoundError(`Wallet ${input.walletId} not found`);
        throw new InsufficientBalanceError(input.walletId, wallet.balance_paise, input.amountPaise);
      }

      const entryId = randomUUID();
      const inserted = await trx
        .insertInto('ledger_entries')
        .values({
          id: entryId,
          wallet_id: input.walletId,
          entry_type: entryType,
          amount_paise: input.amountPaise,
          balance_after_paise: updated.balance_paise,
          idempotency_key: input.idempotencyKey,
          reference_id: input.referenceId ?? null,
        })
        .onConflict((oc) => oc.columns(['wallet_id', 'idempotency_key']).doNothing())
        .returning('id')
        .executeTakeFirst();

      if (!inserted) {
        // A concurrent request with the same idempotency key just won.
        // Throw to trigger transaction rollback — that undoes the UPDATE above.
        throw new IdempotencyRace();
      }

      const entry = await trx
        .selectFrom('ledger_entries')
        .selectAll()
        .where('id', '=', entryId)
        .executeTakeFirstOrThrow();

      return { entry, balancePaise: updated.balance_paise, idempotent: false };
    });
  } catch (err) {
    if (err instanceof IdempotencyRace) {
      // Rollback already happened. Fetch the entry that won.
      const winner = await db
        .selectFrom('ledger_entries')
        .selectAll()
        .where('wallet_id', '=', input.walletId)
        .where('idempotency_key', '=', input.idempotencyKey)
        .executeTakeFirstOrThrow();
      const wallet = await db
        .selectFrom('wallets')
        .select('balance_paise')
        .where('id', '=', input.walletId)
        .executeTakeFirstOrThrow();
      return { entry: winner, balancePaise: wallet.balance_paise, idempotent: true };
    }
    throw err;
  }
}
