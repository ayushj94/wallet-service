import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ValidationError } from '../errors';
import * as walletService from '../services/wallet-service';
import type { LedgerEntryRow } from '../db/schema';

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const;

const mutationBody = {
  type: 'object',
  required: ['idempotencyKey'],
  properties: {
    amountPaise: { type: 'integer', minimum: 1 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    referenceId: { type: 'string', maxLength: 128 },
  },
  additionalProperties: false,
} as const;

const deductBody = { ...mutationBody, required: [] as string[] };

function entryDto(e: LedgerEntryRow): Record<string, unknown> {
  return {
    id: e.id,
    walletId: e.wallet_id,
    entryType: e.entry_type,
    amountPaise: e.amount_paise,
    balanceAfterPaise: e.balance_after_paise,
    idempotencyKey: e.idempotency_key,
    referenceId: e.reference_id,
    createdAt: e.created_at,
  };
}

function readIdempotencyKey(req: FastifyRequest, bodyKey: string | undefined): string {
  const header = req.headers['idempotency-key'];
  const fromHeader = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  const key = fromHeader ?? bodyKey;
  if (!key) throw new ValidationError('idempotencyKey is required (header Idempotency-Key or body field)');
  return key;
}

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { customerId: string } }>(
    '/wallets',
    {
      schema: {
        body: {
          type: 'object',
          required: ['customerId'],
          properties: { customerId: { type: 'string', minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const wallet = await walletService.createWallet({ customerId: req.body.customerId });
      return reply.code(201).send({
        id: wallet.id,
        customerId: wallet.customer_id,
        balancePaise: wallet.balance_paise,
        createdAt: wallet.created_at,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { amountPaise: number; idempotencyKey?: string; referenceId?: string } }>(
    '/wallets/:id/topup',
    { schema: { params: idParam, body: { ...mutationBody, required: ['amountPaise', 'idempotencyKey'] } } },
    async (req, reply) => {
      const idempotencyKey = readIdempotencyKey(req, req.body.idempotencyKey);
      const result = await walletService.topup({
        walletId: req.params.id,
        amountPaise: req.body.amountPaise,
        idempotencyKey,
        referenceId: req.body.referenceId,
      });
      return reply.code(result.idempotent ? 200 : 201).send({
        entry: entryDto(result.entry),
        balancePaise: result.balancePaise,
        idempotent: result.idempotent,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { amountPaise?: number; idempotencyKey?: string; referenceId?: string } }>(
    '/wallets/:id/deduct',
    { schema: { params: idParam, body: deductBody } },
    async (req, reply) => {
      // Spec fixes deduct at ₹100. Default kept so the spec's flow works with no body fields.
      const amountPaise = req.body.amountPaise ?? 10000;
      const idempotencyKey = readIdempotencyKey(req, req.body.idempotencyKey);
      const result = await walletService.deduct({
        walletId: req.params.id,
        amountPaise,
        idempotencyKey,
        referenceId: req.body.referenceId,
      });
      return reply.code(result.idempotent ? 200 : 201).send({
        entry: entryDto(result.entry),
        balancePaise: result.balancePaise,
        idempotent: result.idempotent,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/wallets/:id/balance',
    { schema: { params: idParam } },
    async (req) => {
      const result = await walletService.getBalance(req.params.id);
      return { walletId: result.walletId, balancePaise: result.balancePaise };
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
