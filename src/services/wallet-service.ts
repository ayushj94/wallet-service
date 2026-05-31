import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { db } from '../db';
import type { Currency, Database, WalletLedgerEntryRow, WalletRow } from '../db/schema';
import {
  CurrencyMismatchError,
  CustomerAlreadyHasWalletError,
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
  currency: Currency; // required, must match the wallet's currency
}

export interface LedgerOperationResult {
  entry: WalletLedgerEntryRow;
  balance: number;
  currency: Currency;
  idempotent: boolean;
}

export interface ListLedgerEntriesOptions {
  limit: number;
  cursor?: string;
}

export interface ListLedgerEntriesResult {
  entries: WalletLedgerEntryRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function createWallet(input: CreateWalletInput): Promise<WalletRow> {
  try {
    return await db
      .insertInto('wallets')
      .values({
        id: randomUUID(),
        customer_id: input.customerId,
        currency: input.currency,
        balance: 0,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    // Postgres SQLSTATE 23505 + the wallets_customer_id_key constraint name
    // means a wallet already exists for this customer. Surface as a typed
    // domain error rather than letting it bubble as a generic 409.
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'wallets_customer_id_key') {
      throw new CustomerAlreadyHasWalletError(input.customerId);
    }
    throw err;
  }
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

/**
 * Cursor pagination on (created_at DESC, id DESC).
 *
 * Cursor is the ID of the last entry from the previous page. We look up that
 * entry's created_at, then fetch entries strictly older than it. Stable under
 * concurrent writes because the cursor is anchored to a specific row, not an
 * offset that can shift.
 */
export async function listLedgerEntries(
  walletId: string,
  options: ListLedgerEntriesOptions,
): Promise<ListLedgerEntriesResult> {
  const wallet = await db
    .selectFrom('wallets')
    .select('id')
    .where('id', '=', walletId)
    .executeTakeFirst();
  if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);

  let query = db
    .selectFrom('wallet_ledger_entries')
    .selectAll()
    .where('wallet_id', '=', walletId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.limit + 1); // fetch one extra to know if there's more

  if (options.cursor) {
    // The cursor IS the anchor entry's id, so we only need to fetch its
    // created_at. The id from the cursor itself is used as the tiebreaker
    // for any entries that share the anchor's millisecond timestamp.
    const cursorId = options.cursor;
    const anchor = await db
      .selectFrom('wallet_ledger_entries')
      .select('created_at')
      .where('id', '=', cursorId)
      .where('wallet_id', '=', walletId)
      .executeTakeFirst();
    if (!anchor) throw new ValidationError(`Invalid cursor: ${cursorId}`);
    query = query.where(({ eb, or, and }) =>
      or([
        eb('created_at', '<', anchor.created_at),
        and([eb('created_at', '=', anchor.created_at), eb('id', '<', cursorId)]),
      ]),
    );
  }

  const rows = await query.execute();
  const hasMore = rows.length > options.limit;
  const entries = hasMore ? rows.slice(0, options.limit) : rows;
  const nextCursor = hasMore ? entries[entries.length - 1]!.id : null;

  return { entries, nextCursor, hasMore };
}

export async function topup(input: LedgerOperationInput): Promise<LedgerOperationResult> {
  if (input.amount <= 0) throw new ValidationError('amount must be positive');
  return recordLedgerEntry('CREDIT', input);
}

export async function deduct(input: LedgerOperationInput): Promise<LedgerOperationResult> {
  if (input.amount <= 0) throw new ValidationError('amount must be positive');
  return recordLedgerEntry('DEBIT', input);
}

// ─── Internals for recordLedgerEntry ─────────────────────────────────────────

type EntryType = 'CREDIT' | 'DEBIT';
type Trx = Transaction<Database>;

/** Marker error: a concurrent request committed first with the same reference. */
class IdempotencyRace extends Error {}

/**
 * Records a credit or debit using Postgres' optimistic concurrency pattern.
 * Orchestrates three phases:
 *   1. Validate the wallet + currency.
 *   2. If an entry for this reference already exists, return it (idempotent path).
 *   3. Otherwise mutate-and-record inside a transaction. If a concurrent
 *      request beats us to the INSERT, recover by fetching the entry that won.
 */
async function recordLedgerEntry(
  entryType: EntryType,
  input: LedgerOperationInput,
): Promise<LedgerOperationResult> {
  const wallet = await loadWalletForOperation(input.walletId, input.currency);

  const existing = await findEntryByReference(input);
  if (existing) {
    return idempotentResult(existing, wallet.currency);
  }

  try {
    return await db
      .transaction()
      .execute((trx) => mutateAndRecord(trx, entryType, input, wallet.currency));
  } catch (err) {
    if (err instanceof IdempotencyRace) {
      // A concurrent request committed first. Fetch the entry it wrote and return it.
      const winner = await findEntryByReference(input);
      if (!winner) throw new Error('Idempotency race recovery: winning entry not found');
      return idempotentResult(winner, wallet.currency);
    }
    throw err;
  }
}

async function loadWalletForOperation(
  walletId: string,
  requestedCurrency: Currency,
): Promise<{ currency: Currency }> {
  const wallet = await db
    .selectFrom('wallets')
    .select('currency')
    .where('id', '=', walletId)
    .executeTakeFirst();
  if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
  if (requestedCurrency !== wallet.currency) {
    throw new CurrencyMismatchError(wallet.currency, requestedCurrency);
  }
  return wallet;
}

async function findEntryByReference(
  input: Pick<LedgerOperationInput, 'walletId' | 'referenceType' | 'referenceId'>,
): Promise<WalletLedgerEntryRow | undefined> {
  return db
    .selectFrom('wallet_ledger_entries')
    .selectAll()
    .where('wallet_id', '=', input.walletId)
    .where('reference_type', '=', input.referenceType)
    .where('reference_id', '=', input.referenceId)
    .executeTakeFirst();
}

function idempotentResult(entry: WalletLedgerEntryRow, currency: Currency): LedgerOperationResult {
  return {
    entry,
    balance: entry.balance_after,
    currency,
    idempotent: true,
  };
}

/**
 * Inside one transaction:
 *   - Conditional UPDATE on wallets. Succeeds only if balance + signed stays
 *     non-negative. Returns the new balance.
 *   - INSERT into the ledger with ON CONFLICT DO NOTHING. If a concurrent
 *     request committed an entry with the same reference, returns 0 rows.
 *     We throw IdempotencyRace so the transaction rolls back, then the
 *     caller fetches the winning entry.
 *
 * The wallet's row-level lock (acquired implicitly by the UPDATE) serializes
 * concurrent operations on the same wallet. The UNIQUE constraint on
 * (wallet_id, reference_type, reference_id) backs up the idempotency check.
 */
async function mutateAndRecord(
  trx: Trx,
  entryType: EntryType,
  input: LedgerOperationInput,
  currency: Currency,
): Promise<LedgerOperationResult> {
  const signed = entryType === 'CREDIT' ? input.amount : -input.amount;

  const updated = await trx
    .updateTable('wallets')
    .set({ balance: sql<number>`balance + ${signed}`, updated_at: sql<Date>`NOW()` })
    .where('id', '=', input.walletId)
    .where(sql<boolean>`balance + ${signed} >= 0`)
    .returning('balance')
    .executeTakeFirst();

  if (!updated) {
    // Wallet exists (validated upstream), so this must be insufficient balance.
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
    throw new IdempotencyRace();
  }

  const entry = await trx
    .selectFrom('wallet_ledger_entries')
    .selectAll()
    .where('id', '=', entryId)
    .executeTakeFirstOrThrow();

  return { entry, balance: updated.balance, currency, idempotent: false };
}
