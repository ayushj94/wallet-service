import type { FastifyInstance } from 'fastify';
import * as walletService from '../services/wallet-service';
import type { Currency, WalletLedgerEntryRow } from '../db/schema';

const CURRENCY_VALUES = ['USD', 'EUR', 'GBP', 'CAD', 'INR'] as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

// amount and currency are required on both topup and deduct. The currency on
// the request acts as a "I think this wallet is in X" assertion — if it
// disagrees with the wallet, we return 422 instead of silently mis-charging.
//
// `maximum` on amount is Number.MAX_SAFE_INTEGER (2^53 - 1). This isn't a
// business cap — it's the largest integer JavaScript numbers can represent
// without precision loss. Above this, JSON.parse silently rounds, which
// would corrupt amounts mid-flight. We reject before that can happen.
const MAX_SAFE_AMOUNT = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991
const mutationBody = {
  type: 'object',
  required: ['amount', 'currency', 'referenceType', 'referenceId'],
  properties: {
    amount: { type: 'integer', minimum: 1, maximum: MAX_SAFE_AMOUNT },
    currency: { type: 'string', enum: CURRENCY_VALUES },
    referenceType: { type: 'string', minLength: 1, maxLength: 32 },
    referenceId: { type: 'string', minLength: 1, maxLength: 128 },
  },
  additionalProperties: false,
} as const;

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

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { customerId: string; currency: Currency } }>(
    '/wallets',
    {
      schema: {
        body: {
          type: 'object',
          required: ['customerId', 'currency'],
          properties: {
            customerId: { type: 'string', minLength: 1, maxLength: 64 },
            currency: { type: 'string', enum: CURRENCY_VALUES },
          },
          additionalProperties: false,
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
    { schema: { params: idParam, body: mutationBody } },
    async (req, reply) => {
      const result = await walletService.topup({
        walletId: req.params.id,
        amount: req.body.amount,
        currency: req.body.currency,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
      });
      return reply.code(result.idempotent ? 200 : 201).send({
        entry: entryDto(result.entry),
        balance: result.balance,
        currency: result.currency,
        idempotent: result.idempotent,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: MutationBody }>(
    '/wallets/:id/deduct',
    { schema: { params: idParam, body: mutationBody } },
    async (req, reply) => {
      const result = await walletService.deduct({
        walletId: req.params.id,
        amount: req.body.amount,
        currency: req.body.currency,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
      });
      return reply.code(result.idempotent ? 200 : 201).send({
        entry: entryDto(result.entry),
        balance: result.balance,
        currency: result.currency,
        idempotent: result.idempotent,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/wallets/:id/balance',
    { schema: { params: idParam } },
    async (req) => {
      const result = await walletService.getBalance(req.params.id);
      return { walletId: result.walletId, balance: result.balance, currency: result.currency };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number; cursor?: string } }>(
    '/wallets/:id/transactions',
    {
      schema: {
        params: idParam,
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            cursor: { type: 'string', minLength: 1, maxLength: 64 },
          },
          additionalProperties: false,
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
