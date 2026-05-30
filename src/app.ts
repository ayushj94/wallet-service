import Fastify, { type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { sql } from 'kysely';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { config } from './config';
import { db } from './db';
import { AppError } from './errors';
import { registerWalletRoutes } from './routes/wallets';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.logLevel === 'debug' ? { target: 'pino-pretty' } : undefined,
    },
  });

  // Validation strategy:
  //   - Request body  -> strict (coerceTypes: false). A string-looking-like-a-number
  //     from a caller is a bug we want to surface, not paper over.
  //   - Query/params  -> lenient (coerceTypes: 'array'). HTTP query strings are
  //     always strings on the wire ("?limit=5"), so we need the standard
  //     string-to-int coercion or the schema can never accept them.
  const baseAjvOptions = { removeAdditional: true, useDefaults: true, allErrors: false };
  const strictAjv = new Ajv({ ...baseAjvOptions, coerceTypes: false });
  const lenientAjv = new Ajv({ ...baseAjvOptions, coerceTypes: 'array' });
  // ajv-formats adds the standard string formats (uuid, date-time, email, …).
  // We use `format: 'uuid'` on path params to reject obviously-bad IDs at
  // the edge instead of round-tripping the DB to discover they don't exist.
  addFormats(strictAjv);
  addFormats(lenientAjv);
  app.setValidatorCompiler(({ schema, httpPart }) => {
    const ajv = httpPart === 'body' ? strictAjv : lenientAjv;
    return ajv.compile(schema);
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
    // SQLSTATE 22003 is numeric_value_out_of_range — fires when balance + amount
    // would exceed BIGINT (2^63 - 1). The amount itself is already capped at
    // Number.MAX_SAFE_INTEGER, but cumulative balance could in theory reach this
    // for very long-lived wallets. Return a clean 422 instead of leaking a 500.
    if (e.code === '22003') {
      return reply.code(422).send({
        error: {
          code: 'AMOUNT_OUT_OF_RANGE',
          message: 'Amount would push the balance beyond the system limit',
        },
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });

  // Liveness: is the process up? Always OK if we can answer.
  // Readiness: are we ready to serve traffic? Checks the database.
  // /health is kept as an alias for /health/live for backwards compatibility.
  const live = async (): Promise<{ status: string }> => ({ status: 'ok' });
  const ready = async (
    _req: unknown,
    reply: { code: (n: number) => unknown },
  ): Promise<{ status: string; db: string }> => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: 'ok', db: 'ok' };
    } catch {
      reply.code(503);
      return { status: 'unavailable', db: 'unreachable' };
    }
  };
  app.get('/health', live);
  app.get('/health/live', live);
  app.get('/health/ready', ready);

  // OpenAPI 3.1 spec is generated from every route's JSON schemas.
  // Interactive UI served at /docs.
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Wallet Service',
        description: 'Prepaid wallet API — credits, debits, balance, ledger.',
        version: '0.1.0',
      },
      tags: [{ name: 'wallets', description: 'Wallet operations' }],
    },
  });
  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  await registerWalletRoutes(app);

  return app;
}
