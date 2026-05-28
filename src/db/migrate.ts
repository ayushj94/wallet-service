import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'mysql2/promise';
import { config } from '../config';

async function main(): Promise<void> {
  const conn = await createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
  });

  const dir = join(__dirname, '..', '..', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    console.log(`Running migration: ${file}`);
    await conn.query(sql);
  }

  await conn.end();
  console.log('Migrations complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
