import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { db } from '../db';
import type { Currency, WalletLedgerEntryRow, WalletRow } from '../db/schema';
import {
  CurrencyMismatchError,
  InsufficientBalanceError,
  NotFoundError,
  ValidationError,
} from '../errors';

export interface CreateWalletInput {
  customerId: string;
  currency: Currency;
}

export interface LedgerOperationInput {
  walletId: string;
  amount: number;
  referenceType: string;
  referenceId: string;
  currency: Currency; // required — must match the wallet's currency
}

export interface LedgerOperationResult {
  entry: WalletLedgerEntryRow;
  balance: number;
  currency: Currency;
  idempotent: boolean;
}

export async function createWallet(input: CreateWalletInput): Promise<WalletRow> {
  return db
    .insertInto('wallets')
    .values({ id: randomUUID(), customer_id: input.customerId, currency: input.currency, balance: 0 })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function getBalance(
  walletId: string,
): Promise<{ walletId: string; balance: number; currency: Currency }> {
  const row = await db
    .selectFrom('wallets')
    .select(['id', 'balance', 'currency'])
    .where('id', '=', walletId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError(`Wallet ${walletId} not found`);
  return { walletId: row.id, balance: row.balance, currency: row.currency };
}

export async function listLedgerEntries(
  walletId: string,
  limit = 100,
): Promise<WalletLedgerEntryRow[]> {
  const wallet = await db.selectFrom('wallets').select('id').where('id', '=', walletId).executeTakeFirst();
  if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);

  return db
    .selectFrom('wallet_ledger_entries')
    .selectAll()
    .where('wallet_id', '=', walletId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
}

export async function topup(input: LedgerOperationInput): Promise<LedgerOperationResult> {
  if (input.amount <= 0) throw new ValidationError('amount must be positive');
  return recordLedgerEntry('CREDIT', input);
}

export async function deduct(input: LedgerOperationInput): Promise<LedgerOperationResult> {
  if (input.amount <= 0) throw new ValidationError('amount must be positive');
  return recordLedgerEntry('DEBIT', input);
}

/**
 * Records a credit or debit using Postgres' optimistic concurrency pattern.
 *
 * The flow:
 *   1. Look up whether an entry already exists for this
 *      (wallet_id, reference_type, reference_id). If yes, return it.
 *   2. Otherwise open a transaction and:
 *      a. Conditionally update the wallet balance with RETURNING. The WHERE
 *         clause refuses the update if the resulting balance would be negative,
 *         so insufficient-balance is detected atomically with the mutation.
 *      b. Insert a ledger entry. If a concurrent request just committed an
 *         entry with the same (wallet_id, reference_type, reference_id), the
 *         ON CONFLICT DO NOTHING returns no row — we throw, the transaction
 *         rolls back (which undoes step a), and the outer catch fetches the
 *         entry that committed first.
 *
 * Why this works: Postgres' row-level lock on the wallet row (acquired inside
 * UPDATE) makes step 2a serial across concurrent requests. The UNIQUE
 * constraint on (wallet_id, reference_type, reference_id) makes step 2b
 * race-safe.
 *
 * Idempotency contract: we assume the source system uses the same reference_id
 * on a retry of the same logical instruction. This is the standard contract
 * for ORDER_SYSTEM, PAYMENT_SYSTEM, etc.
 */
class IdempotencyRace extends Error {}

async function recordLedgerEntry(
  entryType: 'CREDIT' | 'DEBIT',
  input: LedgerOperationInput,
): Promise<LedgerOperationResult> {
  const wallet = await db
    .selectFrom('wallets')
    .select('currency')
    .where('id', '=', input.walletId)
    .executeTakeFirst();
  if (!wallet) throw new NotFoundError(`Wallet ${input.walletId} not found`);

  if (input.currency !== wallet.currency) {
    throw new CurrencyMismatchError(wallet.currency, input.currency);
  }

  // Does an entry already exist for this reference? If so, return it.
  const entry = await db
    .selectFrom('wallet_ledger_entries')
    .selectAll()
    .where('wallet_id', '=', input.walletId)
    .where('reference_type', '=', input.referenceType)
    .where('reference_id', '=', input.referenceId)
    .executeTakeFirst();

  if (entry) {
    return {
      entry,
      balance: entry.balance_after,
      currency: wallet.currency,
      idempotent: true,
    };
  }

  // Otherwise, record a new entry.
  try {
    return await db.transaction().execute(async (trx) => {
      const signed = entryType === 'CREDIT' ? input.amount : -input.amount;

      // Conditional update — moves balance only if the new value would be non-negative.
      // updated_at is bumped explicitly because Postgres doesn't have MySQL's
      // ON UPDATE CURRENT_TIMESTAMP behaviour.
      const updated = await trx
        .updateTable('wallets')
        .set({ balance: sql<number>`balance + ${signed}`, updated_at: sql<Date>`NOW()` })
        .where('id', '=', input.walletId)
        .where(sql<boolean>`balance + ${signed} >= 0`)
        .returning('balance')
        .executeTakeFirst();

      if (!updated) {
        // Wallet exists (checked above), so this must be insufficient balance.
        const fresh = await trx
          .selectFrom('wallets')
          .select('balance')
          .where('id', '=', input.walletId)
          .executeTakeFirstOrThrow();
        throw new InsufficientBalanceError(input.walletId, fresh.balance, input.amount);
      }

      const entryId = randomUUID();
      const inserted = await trx
        .insertInto('wallet_ledger_entries')
        .values({
          id: entryId,
          wallet_id: input.walletId,
          entry_type: entryType,
          amount: input.amount,
          balance_after: updated.balance,
          reference_type: input.referenceType,
          reference_id: input.referenceId,
        })
        .onConflict((oc) => oc.columns(['wallet_id', 'reference_type', 'reference_id']).doNothing())
        .returning('id')
        .executeTakeFirst();

      if (!inserted) {
        // A concurrent request with the same reference won the race.
        // Throw to roll back the wallet UPDATE we just did.
        throw new IdempotencyRace();
      }

      const entry = await trx
        .selectFrom('wallet_ledger_entries')
        .selectAll()
        .where('id', '=', entryId)
        .executeTakeFirstOrThrow();

      return {
        entry,
        balance: updated.balance,
        currency: wallet.currency,
        idempotent: false,
      };
    });
  } catch (err) {
    if (err instanceof IdempotencyRace) {
      // A concurrent request committed first. Fetch the entry it wrote and return it.
      const entry = await db
        .selectFrom('wallet_ledger_entries')
        .selectAll()
        .where('wallet_id', '=', input.walletId)
        .where('reference_type', '=', input.referenceType)
        .where('reference_id', '=', input.referenceId)
        .executeTakeFirstOrThrow();
      return {
        entry,
        balance: entry.balance_after,
        currency: wallet.currency,
        idempotent: true,
      };
    }
    throw err;
  }
}
