import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config';
import { AppError } from './errors';
import { registerWalletRoutes } from './routes/wallets';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.logLevel === 'debug' ? { target: 'pino-pretty' } : undefined,
    },
    // Strict input typing: refuse to silently coerce "100" -> 100, or true -> 1.
    // For a financial API, a string-looking-like-a-number from a caller is a
    // bug we should surface, not paper over.
    ajv: { customOptions: { coerceTypes: false } },
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    // Fastify schema validation failures arrive with a `validation` array.
    if (Array.isArray((err as { validation?: unknown }).validation)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    // Postgres surfaces unique-violation as SQLSTATE 23505. The service path
    // catches the race internally, but this is a backstop for any other code
    // path that could ever trip the same constraint.
    const e = err as Error & { code?: string };
    if (e.code === '23505') {
      return reply.code(409).send({
        error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Duplicate idempotency key' },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  await registerWalletRoutes(app);

  return app;
}
