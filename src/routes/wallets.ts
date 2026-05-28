import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ValidationError } from '../errors';
import * as walletService from '../services/wallet-service';
import type { TransactionRow } from '../db/schema';

interface CreateWalletBody {
  customerId: string;
}

interface MutationBody {
  amountPaise?: number;
  idempotencyKey?: string;
  reference?: string;
}

interface WalletIdParams {
  id: string;
}

function txnDto(t: TransactionRow): Record<string, unknown> {
  return {
    id: t.id,
    walletId: t.wallet_id,
    type: t.type,
    amountPaise: t.amount_paise,
    balanceAfterPaise: t.balance_after_paise,
    idempotencyKey: t.idempotency_key,
    reference: t.reference,
    createdAt: t.created_at,
  };
}

function readIdempotencyKey(req: FastifyRequest, body: MutationBody): string {
  const header = req.headers['idempotency-key'];
  const fromHeader = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
  const key = fromHeader ?? body.idempotencyKey;
  if (!key) {
    throw new ValidationError('idempotencyKey is required (header Idempotency-Key or body field)');
  }
  return key;
}

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateWalletBody }>('/wallets', async (req, reply) => {
    const { customerId } = req.body ?? ({} as CreateWalletBody);
    if (!customerId || typeof customerId !== 'string') {
      throw new ValidationError('customerId is required');
    }
    const wallet = await walletService.createWallet({ customerId });
    return reply.code(201).send({
      id: wallet.id,
      customerId: wallet.customer_id,
      balancePaise: wallet.balance_paise,
      createdAt: wallet.created_at,
    });
  });

  app.post<{ Params: WalletIdParams; Body: MutationBody }>(
    '/wallets/:id/topup',
    async (req: FastifyRequest<{ Params: WalletIdParams; Body: MutationBody }>, reply: FastifyReply) => {
      const body = req.body ?? {};
      const amountPaise = body.amountPaise;
      if (typeof amountPaise !== 'number' || !Number.isInteger(amountPaise) || amountPaise <= 0) {
        throw new ValidationError('amountPaise must be a positive integer');
      }
      const idempotencyKey = readIdempotencyKey(req, body);

      const result = await walletService.topup({
        walletId: req.params.id,
        amountPaise,
        idempotencyKey,
        reference: body.reference,
      });

      return reply.code(result.idempotent ? 200 : 201).send({
        transaction: txnDto(result.transaction),
        balancePaise: result.balancePaise,
        idempotent: result.idempotent,
      });
    },
  );

  app.post<{ Params: WalletIdParams; Body: MutationBody }>(
    '/wallets/:id/deduct',
    async (req, reply) => {
      const body = req.body ?? {};
      // Spec fixes deduct at ₹100. We accept the amount in the body for flexibility,
      // but default to 10000 paise (₹100) when missing — matches the assignment's flow.
      const amountPaise = body.amountPaise ?? 10000;
      if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
        throw new ValidationError('amountPaise must be a positive integer');
      }
      const idempotencyKey = readIdempotencyKey(req, body);

      const result = await walletService.deduct({
        walletId: req.params.id,
        amountPaise,
        idempotencyKey,
        reference: body.reference,
      });

      return reply.code(result.idempotent ? 200 : 201).send({
        transaction: txnDto(result.transaction),
        balancePaise: result.balancePaise,
        idempotent: result.idempotent,
      });
    },
  );

  app.get<{ Params: WalletIdParams }>('/wallets/:id/balance', async (req) => {
    const result = await walletService.getBalance(req.params.id);
    return { walletId: result.walletId, balancePaise: result.balancePaise };
  });

  app.get<{ Params: WalletIdParams; Querystring: { limit?: string } }>(
    '/wallets/:id/transactions',
    async (req) => {
      const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
      const rows = await walletService.listTransactions(req.params.id, limit);
      return { walletId: req.params.id, transactions: rows.map(txnDto) };
    },
  );
}
