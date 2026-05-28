import type { FastifyInstance } from 'fastify';
import * as walletService from '../services/wallet-service';
import type { Currency, WalletLedgerEntryRow } from '../db/schema';

const CURRENCY_VALUES = ['USD', 'EUR', 'GBP', 'CAD', 'INR'] as const;

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

const mutationBody = {
  type: 'object',
  required: ['referenceType', 'referenceId'],
  properties: {
    amount: { type: 'integer', minimum: 1 },
    referenceType: { type: 'string', minLength: 1, maxLength: 32 },
    referenceId: { type: 'string', minLength: 1, maxLength: 128 },
    currency: { type: 'string', enum: CURRENCY_VALUES },
  },
  additionalProperties: false,
} as const;

const deductBody = { ...mutationBody, required: ['referenceType', 'referenceId'] };
const topupBody = { ...mutationBody, required: ['amount', 'referenceType', 'referenceId'] };

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

  app.post<{
    Params: { id: string };
    Body: { amount: number; referenceType: string; referenceId: string; currency?: Currency };
  }>(
    '/wallets/:id/topup',
    { schema: { params: idParam, body: topupBody } },
    async (req, reply) => {
      const result = await walletService.topup({
        walletId: req.params.id,
        amount: req.body.amount,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
        currency: req.body.currency,
      });
      return reply.code(result.idempotent ? 200 : 201).send({
        entry: entryDto(result.entry),
        balance: result.balance,
        currency: result.currency,
        idempotent: result.idempotent,
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { amount?: number; referenceType: string; referenceId: string; currency?: Currency };
  }>(
    '/wallets/:id/deduct',
    { schema: { params: idParam, body: deductBody } },
    async (req, reply) => {
      // Spec fixes deduct at ₹100 for the order flow. Default keeps that case
      // ergonomic; clients with other amounts pass them explicitly.
      const amount = req.body.amount ?? 10000;
      const result = await walletService.deduct({
        walletId: req.params.id,
        amount,
        referenceType: req.body.referenceType,
        referenceId: req.body.referenceId,
        currency: req.body.currency,
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

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/wallets/:id/transactions',
    {
      schema: {
        params: idParam,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
        },
      },
    },
    async (req) => {
      const rows = await walletService.listLedgerEntries(req.params.id, req.query.limit ?? 100);
      return { walletId: req.params.id, entries: rows.map(entryDto) };
    },
  );
}
