import type { FastifyInstance } from 'fastify';
import * as walletService from '../services/wallet-service';
import type { Currency, WalletLedgerEntryRow } from '../db/schema';

const CURRENCY_VALUES = ['USD', 'EUR', 'GBP', 'CAD', 'INR'] as const;

// Whitelisted upstream systems that may write to the wallet.
// Adding a new caller is a deliberate schema change: update this list AND the
// CHECK constraint in migrations/001_init.sql so the DB rejects unknown values too.
const REFERENCE_TYPES = [
  'ORDER_SYSTEM', //           debits when an order is placed (Order Service)
  'PAYMENT_GATEWAY_SYSTEM', // credits from customer top-ups (payment gateway)
] as const;

// ─── Request schemas ─────────────────────────────────────────────────────────

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

// amount and currency are required on both topup and deduct. The currency on
// the request acts as a "I think this wallet is in X" assertion. If it
// disagrees with the wallet, we return 422 instead of silently mis-charging.
//
// `maximum` on amount is Number.MAX_SAFE_INTEGER (2^53 - 1). This isn't a
// business cap. It's the largest integer JavaScript numbers can represent
// without precision loss. Above this, JSON.parse silently rounds, which
// would corrupt amounts mid-flight. We reject before that can happen.
const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
const mutationBody = {
  type: 'object',
  required: ['amount', 'currency', 'referenceType', 'referenceId'],
  properties: {
    amount: { type: 'integer', minimum: 1, maximum: MAX_SAFE_AMOUNT },
    currency: { type: 'string', enum: CURRENCY_VALUES },
    referenceType: { type: 'string', enum: REFERENCE_TYPES },
    referenceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const;

const createWalletBody = {
  type: 'object',
  required: ['customerId', 'currency'],
  properties: {
    customerId: { type: 'string', format: 'uuid' },
    currency: { type: 'string', enum: CURRENCY_VALUES },
  },
  additionalProperties: false,
} as const;

const transactionsQuery = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    cursor: { type: 'string', minLength: 1, maxLength: 64 },
  },
  additionalProperties: false,
} as const;

// ─── Response schemas ────────────────────────────────────────────────────────
//
// These describe the wire shape of every successful response and the error
// envelope. Fastify uses them both to serialise the output (via
// fast-json-stringify) and to auto-generate OpenAPI docs at /docs.

const ledgerEntrySchema = {
  type: 'object',
  required: [
    'id',
    'walletId',
    'entryType',
    'amount',
    'balanceAfter',
    'referenceType',
    'referenceId',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    walletId: { type: 'string', format: 'uuid' },
    entryType: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
    amount: { type: 'integer' },
    balanceAfter: { type: 'integer' },
    referenceType: { type: 'string' },
    referenceId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const walletResponseSchema = {
  type: 'object',
  required: ['id', 'customerId', 'currency', 'balance', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    customerId: { type: 'string', format: 'uuid' },
    currency: { type: 'string', enum: CURRENCY_VALUES },
    balance: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

const balanceResponseSchema = {
  type: 'object',
  required: ['walletId', 'balance', 'currency'],
  properties: {
    walletId: { type: 'string', format: 'uuid' },
    balance: { type: 'integer' },
    currency: { type: 'string', enum: CURRENCY_VALUES },
  },
} as const;

// Mutation response is a flat shape: every field from the ledger entry plus
// the wallet's currency at the root. No nested `entry` object, no separate
// `balance` (balanceAfter is the same value), no `idempotent` flag
// (status code 200 vs 201 already conveys whether this was a replay).
const mutationResponseSchema = {
  type: 'object',
  required: [
    'id',
    'walletId',
    'entryType',
    'amount',
    'balanceAfter',
    'referenceType',
    'referenceId',
    'createdAt',
    'currency',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    walletId: { type: 'string', format: 'uuid' },
    entryType: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
    amount: { type: 'integer' },
    balanceAfter: { type: 'integer' },
    referenceType: { type: 'string' },
    referenceId: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    currency: { type: 'string', enum: CURRENCY_VALUES },
  },
} as const;

const transactionsResponseSchema = {
  type: 'object',
  required: ['walletId', 'entries', 'nextCursor', 'hasMore'],
  properties: {
    walletId: { type: 'string', format: 'uuid' },
    entries: { type: 'array', items: ledgerEntrySchema },
    nextCursor: { type: ['string', 'null'] },
    hasMore: { type: 'boolean' },
  },
} as const;

const errorResponseSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function entryDto(e: WalletLedgerEntryRow): Record<string, unknown> {
  return {
    id: e.id,
    walletId: e.wallet_id,
    entryType: e.entry_type,
    amount: e.amount,
    balanceAfter: e.balance_after,
    referenceType: e.reference_type,
    referenceId: e.reference_id,
    createdAt: e.created_at,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { customerId: string; currency: Currency } }>(
    '/wallets',
    {
      schema: {
        description: 'Create a new wallet for a customer in a specific currency.',
        tags: ['wallets'],
        body: createWalletBody,
        response: {
          201: walletResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const wallet = await walletService.createWallet({
        customerId: req.body.customerId,
        currency: req.body.currency,
      });
      return reply.code(201).send({
        id: wallet.id,
        customerId: wallet.customer_id,
        currency: wallet.currency,
        balance: wallet.balance,
        createdAt: wallet.created_at,
      });
    },
  );

  type MutationBody = {
    amount: number;
    currency: Currency;
    referenceType: string;
    referenceId: string;
  };

  app.post<{ Params: { id: string }; Body: MutationBody }>(
    '/wallets/:id/topup',
    {
      schema: {
        description: 'Credit money to a wallet. Idempotent on (referenceType, referenceId).',
        tags: ['wallets'],
        params: idParam,
        body: mutationBody,
        response: {
          200: mutationResponseSchema,
          201: mutationResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await walletService.topup({
        walletId: req.params.id,
        amount: req.body.amount,
        currency: req.body.currency,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
      });
      return reply
        .code(result.idempotent ? 200 : 201)
        .send({ ...entryDto(result.entry), currency: result.currency });
    },
  );

  app.post<{ Params: { id: string }; Body: MutationBody }>(
    '/wallets/:id/deduct',
    {
      schema: {
        description: 'Debit money from a wallet. Idempotent on (referenceType, referenceId).',
        tags: ['wallets'],
        params: idParam,
        body: mutationBody,
        response: {
          200: mutationResponseSchema,
          201: mutationResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await walletService.deduct({
        walletId: req.params.id,
        amount: req.body.amount,
        currency: req.body.currency,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
      });
      return reply
        .code(result.idempotent ? 200 : 201)
        .send({ ...entryDto(result.entry), currency: result.currency });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/wallets/:id/balance',
    {
      schema: {
        description: 'Get the current balance of a wallet.',
        tags: ['wallets'],
        params: idParam,
        response: {
          200: balanceResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const result = await walletService.getBalance(req.params.id);
      return { walletId: result.walletId, balance: result.balance, currency: result.currency };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/wallets/:id/transactions',
    {
      schema: {
        description: 'List ledger entries for a wallet. Cursor-paginated, newest first.',
        tags: ['wallets'],
        params: idParam,
        querystring: transactionsQuery,
        response: {
          200: transactionsResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (req) => {
      const result = await walletService.listLedgerEntries(req.params.id, {
        limit: req.query.limit ?? 100,
        cursor: req.query.cursor,
      });
      return {
        walletId: req.params.id,
        entries: result.entries.map(entryDto),
        nextCursor: result.nextCursor,
        hasMore: result.hasMore,
      };
    },
  );
}
