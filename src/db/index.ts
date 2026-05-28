import { Kysely, MysqlDialect } from 'kysely';
import { createPool, type Pool } from 'mysql2';
import { config } from '../config';
import type { Database } from './schema';

const pool: Pool = createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 10,
  // Return BIGINT as JS number. Safe here: balances/amounts are paise and
  // stay well below 2^53. If we ever expect larger, switch to bigint type.
  supportBigNumbers: true,
  bigNumberStrings: false,
});

export const db = new Kysely<Database>({
  // Kysely's MysqlPool type is a structural subset of mysql2's Pool. The cast
  // is safe: mysql2's Pool supplies every method Kysely calls.
  dialect: new MysqlDialect({ pool: pool as unknown as never }),
});

export async function closeDb(): Promise<void> {
  await db.destroy();
}
