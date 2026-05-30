import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import { config } from '../config';
import type { Database } from './schema';

// pg returns BIGINT as a string by default to avoid silent precision loss
// for values above 2^53. Our balances/amounts are paise and stay well below
// that — parsing as a JS number is safe and keeps the rest of the code simple.
types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});
