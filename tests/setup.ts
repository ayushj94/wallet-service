import { afterAll, beforeAll, beforeEach } from 'vitest';
import { closeDb, db } from '../src/db';
import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

export let app: FastifyInstance;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  // Truncate between tests. FK from transactions->wallets means order matters.
  await db.deleteFrom('transactions').execute();
  await db.deleteFrom('wallets').execute();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});
