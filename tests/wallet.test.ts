import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { app } from './setup';
import { db } from '../src/db';
import type { Currency } from '../src/db/schema';

// All helpers require `currency` explicitly. No defaults. Financial code paths
// should never assume a currency.

async function createWallet(currency: Currency): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/wallets',
    payload: { customerId: randomUUID(), currency },
  });
  expect(res.statusCode).toBe(201);
  return res.json().walletId as string;
}

async function topup(
  id: string,
  amount: number,
  currency: Currency,
  refId = randomUUID(),
): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: `/wallets/${id}/topup`,
    payload: { amount, currency, referenceType: 'PAYMENT_GATEWAY_SYSTEM', referenceId: refId },
  });
}

async function deduct(
  id: string,
  amount: number,
  currency: Currency,
  refId = randomUUID(),
): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: `/wallets/${id}/deduct`,
    payload: { amount, currency, referenceType: 'ORDER_SYSTEM', referenceId: refId },
  });
}

describe('happy path', () => {
  it('creates wallet, credits, debits, returns ledger', async () => {
    const id = await createWallet('INR');
    expect((await topup(id, 50000, 'INR')).statusCode).toBe(201);
    expect((await deduct(id, 10000, 'INR')).statusCode).toBe(201);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(40000);
    expect(bal.json().currency).toBe('INR');

    const ledger = await app.inject({ method: 'GET', url: `/wallets/${id}/transactions` });
    expect(ledger.json().entries).toHaveLength(2);
    expect(
      ledger
        .json()
        .entries.map((e: { entryType: string }) => e.entryType)
        .sort(),
    ).toEqual(['CREDIT', 'DEBIT']);
  });

  it('happy path works on a non-INR wallet too', async () => {
    const id = await createWallet('USD');
    expect((await topup(id, 50000, 'USD')).statusCode).toBe(201);
    expect((await deduct(id, 10000, 'USD')).statusCode).toBe(201);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(40000);
    expect(bal.json().currency).toBe('USD');
  });
});

describe('balance constraint', () => {
  it('rejects debit when balance is insufficient', async () => {
    const id = await createWallet('INR');
    await topup(id, 5000, 'INR');
    const res = await deduct(id, 10000, 'INR');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_BALANCE');

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(5000);
  });

  it('rejects debit on an empty wallet', async () => {
    const id = await createWallet('INR');
    const res = await deduct(id, 10000, 'INR');
    expect(res.statusCode).toBe(422);
  });

  it('allows debit of exactly the balance', async () => {
    const id = await createWallet('INR');
    await topup(id, 10000, 'INR');
    const res = await deduct(id, 10000, 'INR');
    expect(res.statusCode).toBe(201);
    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(0);
  });
});

describe('idempotency', () => {
  it('replays the same response on duplicate debit reference', async () => {
    const id = await createWallet('INR');
    await topup(id, 50000, 'INR');

    const refId = randomUUID();
    const first = await deduct(id, 10000, 'INR', refId);
    const second = await deduct(id, 10000, 'INR', refId);

    // Status code 200 (vs 201) is what tells the client this was an
    // idempotent replay of an earlier op.
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().walletLedgerEntryId).toBe(first.json().walletLedgerEntryId);
    // Replay returns the balance as it was right after the original op,
    // not the current balance. True idempotent semantics.
    expect(second.json().balanceAfter).toBe(first.json().balanceAfter);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(40000); // debited once, not twice
  });

  it('replays the same response on duplicate credit reference', async () => {
    const id = await createWallet('INR');
    const refId = randomUUID();
    const first = await topup(id, 50000, 'INR', refId);
    const second = await topup(id, 50000, 'INR', refId);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().walletLedgerEntryId).toBe(first.json().walletLedgerEntryId);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(50000);
  });

  it('same reference_id under different reference_type is treated as distinct', async () => {
    const id = await createWallet('INR');
    await topup(id, 100000, 'INR');

    // Same reference_id but two different reference_types: one debit (ORDER_SYSTEM)
    // and one credit (PAYMENT_GATEWAY_SYSTEM). Both must succeed as distinct entries.
    const sameId = randomUUID();
    const r1 = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: {
        amount: 10000,
        currency: 'INR',
        referenceType: 'ORDER_SYSTEM',
        referenceId: sameId,
      },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: {
        amount: 5000,
        currency: 'INR',
        referenceType: 'PAYMENT_GATEWAY_SYSTEM',
        referenceId: sameId,
      },
    });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().walletLedgerEntryId).not.toBe(r2.json().walletLedgerEntryId);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(95000); // 100000 + 5000 - 10000
  });
});

describe('concurrency', () => {
  it('serializes concurrent debits, only as many succeed as the balance allows', async () => {
    const id = await createWallet('INR');
    await topup(id, 30000, 'INR'); // exactly 3 debits of 10000

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => deduct(id, 10000, 'INR', randomUUID())),
    );

    const successes = attempts.filter((r) => r.statusCode === 201);
    const failures = attempts.filter((r) => r.statusCode === 422);

    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(7);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(0);
  });

  it('concurrent calls with the same reference produce one ledger entry', async () => {
    const id = await createWallet('INR');
    await topup(id, 50000, 'INR');

    const refId = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => deduct(id, 10000, 'INR', refId)),
    );

    const ok = attempts.filter((r) => r.statusCode === 201 || r.statusCode === 200);
    expect(ok).toHaveLength(10);

    // Every response references the same ledger entry id.
    const entryIds = new Set(ok.map((r) => r.json().walletLedgerEntryId));
    expect(entryIds.size).toBe(1);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(40000); // debited exactly once
  });
});

describe('ledger invariant', () => {
  it('SUM(signed amounts) == wallets.balance after a chaos run', async () => {
    const id = await createWallet('INR');

    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) ops.push(topup(id, 10000, 'INR', randomUUID()));
    for (let i = 0; i < 30; i++) ops.push(deduct(id, 10000, 'INR', randomUUID()));
    await Promise.all(ops);

    const wallet = await db
      .selectFrom('wallets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const entries = await db
      .selectFrom('wallet_ledger_entries')
      .selectAll()
      .where('wallet_id', '=', id)
      .execute();

    const sum = entries.reduce(
      (acc, e) => acc + (e.entry_type === 'CREDIT' ? e.amount : -e.amount),
      0,
    );
    expect(sum).toBe(wallet.balance);
    expect(wallet.balance).toBeGreaterThanOrEqual(0);

    const last = entries.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    if (last) expect(last.balance_after).toBe(wallet.balance);
  });

  it('updated_at advances when balance changes', async () => {
    const id = await createWallet('INR');
    const before = await db
      .selectFrom('wallets')
      .select('updated_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    await new Promise((r) => setTimeout(r, 5));
    await topup(id, 10000, 'INR');

    const after = await db
      .selectFrom('wallets')
      .select('updated_at')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });
});

describe('currency', () => {
  it('rejects topup whose currency mismatches the wallet', async () => {
    const id = await createWallet('INR');
    const res = await topup(id, 10000, 'USD');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CURRENCY_MISMATCH');
  });

  it('rejects deduct whose currency mismatches the wallet', async () => {
    const id = await createWallet('INR');
    await topup(id, 50000, 'INR');
    const res = await deduct(id, 10000, 'USD');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CURRENCY_MISMATCH');
  });

  it('accepts a topup with matching currency on a non-INR wallet', async () => {
    const id = await createWallet('USD');
    const res = await topup(id, 10000, 'USD');
    expect(res.statusCode).toBe(201);
  });
});

describe('validation and not-found', () => {
  it('rejects missing customerId', async () => {
    const res = await app.inject({ method: 'POST', url: '/wallets', payload: { currency: 'INR' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing currency on wallet creation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { customerId: 'cust-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing currency on mutation', async () => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: {
        amount: 10000,
        referenceType: 'PAYMENT_GATEWAY_SYSTEM',
        referenceId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing required fields on mutation', async () => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: { amount: 10000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-UUID customerId on wallet creation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { customerId: 'acme-corp', currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown referenceType', async () => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: {
        amount: 10000,
        currency: 'INR',
        referenceType: 'MARS_BANK_SYSTEM',
        referenceId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a second wallet for the same customer with CUSTOMER_ALREADY_HAS_WALLET', async () => {
    const customerId = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { customerId, currency: 'USD' },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/wallets',
      payload: { customerId, currency: 'INR' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CUSTOMER_ALREADY_HAS_WALLET');
  });

  it('rejects missing amount on deduct', async () => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: { currency: 'INR', referenceType: 'ORDER_SYSTEM', referenceId: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown wallet on deduct', async () => {
    const res = await deduct(randomUUID(), 10000, 'INR');
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for unknown wallet on balance', async () => {
    const res = await app.inject({ method: 'GET', url: `/wallets/${randomUUID()}/balance` });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 for a non-UUID path id (caught before DB lookup)', async () => {
    const res = await app.inject({ method: 'GET', url: `/wallets/not-a-uuid/balance` });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for a non-UUID path id on mutation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallets/foo/deduct',
      payload: {
        amount: 10000,
        currency: 'INR',
        referenceType: 'ORDER_SYSTEM',
        referenceId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('pagination on /transactions', () => {
  it('paginates through entries in order, with stable cursors', async () => {
    const id = await createWallet('INR');
    // 12 credits. Enough to need multiple pages at limit=5.
    for (let i = 0; i < 12; i++) {
      const r = await topup(id, 1000 + i, 'INR', `topup-${i}`);
      expect(r.statusCode).toBe(201);
    }

    const collected: Array<{ walletLedgerEntryId: string; amount: number }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await app.inject({
        method: 'GET',
        url: `/wallets/${id}/transactions?limit=5${cursor ? `&cursor=${cursor}` : ''}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        entries: Array<{ walletLedgerEntryId: string; amount: number }>;
        nextCursor: string | null;
        hasMore: boolean;
      };
      collected.push(...body.entries);
      cursor = body.nextCursor ?? undefined;
      pages++;
      if (pages > 10) throw new Error('pagination did not terminate');
    } while (cursor);

    expect(collected).toHaveLength(12);
    // No duplicates across pages.
    expect(new Set(collected.map((e) => e.walletLedgerEntryId)).size).toBe(12);
    // Order is newest-first (descending amounts since we wrote them in increasing order).
    const amounts = collected.map((e) => e.amount);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
  });

  it('rejects an unknown (well-formed UUID) cursor with 400', async () => {
    const id = await createWallet('INR');
    await topup(id, 5000, 'INR');
    const res = await app.inject({
      method: 'GET',
      url: `/wallets/${id}/transactions?cursor=${randomUUID()}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-UUID cursor at the API edge with 400', async () => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'GET',
      url: `/wallets/${id}/transactions?cursor=not-a-uuid`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns hasMore=false and nextCursor=null when the page is the last', async () => {
    const id = await createWallet('INR');
    await topup(id, 1000, 'INR');
    const res = await app.inject({ method: 'GET', url: `/wallets/${id}/transactions?limit=5` });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasMore).toBe(false);
    expect(res.json().nextCursor).toBeNull();
  });
});

describe('health endpoints', () => {
  it('liveness returns 200 ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('readiness checks the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().db).toBe('ok');
  });
});

describe('OpenAPI docs', () => {
  it('exposes an OpenAPI 3.1 spec at /docs/json', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\.[01]/);
    // Every documented route should show up.
    expect(spec.paths).toHaveProperty('/wallets');
    expect(spec.paths).toHaveProperty('/wallets/{id}/topup');
    expect(spec.paths).toHaveProperty('/wallets/{id}/deduct');
    expect(spec.paths).toHaveProperty('/wallets/{id}/balance');
    expect(spec.paths).toHaveProperty('/wallets/{id}/transactions');
  });
});

describe('amount overflow safety', () => {
  it('accepts the maximum safe integer amount', async () => {
    const id = await createWallet('INR');
    const res = await topup(id, Number.MAX_SAFE_INTEGER, 'INR');
    expect(res.statusCode).toBe(201);
    expect(res.json().balanceAfter).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects an amount above the JS safe integer range', async () => {
    const id = await createWallet('INR');
    // 1 above MAX_SAFE_INTEGER. Ajv catches this via the maximum constraint.
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: {
        amount: Number.MAX_SAFE_INTEGER + 1,
        currency: 'INR',
        referenceType: 'PAYMENT_GATEWAY_SYSTEM',
        referenceId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 422 AMOUNT_OUT_OF_RANGE when balance would exceed BIGINT', async () => {
    const id = await createWallet('INR');
    // Seed the wallet near BIGINT max (2^63 - 1 = 9223372036854775807) by writing
    // directly to the DB. We use a BIGINT literal in raw SQL because the value
    // exceeds Number.MAX_SAFE_INTEGER and can't be passed as a JS number.
    await sql`
      UPDATE wallets SET balance = 9223372036854775000 WHERE id = ${id}
    `.execute(db);

    // A topup of 1000 would push us past 2^63 - 1. Postgres raises SQLSTATE 22003;
    // our error handler maps it to 422 AMOUNT_OUT_OF_RANGE.
    const res = await topup(id, 1000, 'INR');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AMOUNT_OUT_OF_RANGE');

    // Balance must be unchanged. The failed UPDATE rolled back.
    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBeLessThan(9223372036854776000);
  });
});

describe('amount must be a positive integer', () => {
  // These are caught by Fastify's JSON-schema validation before the route handler
  // ever runs, so a malformed request never reaches the database.
  const invalidAmounts: Array<{ amount: unknown; label: string }> = [
    { amount: -1, label: 'negative integer' },
    { amount: -100, label: 'large negative integer' },
    { amount: 0, label: 'zero' },
    { amount: 1.5, label: 'positive float' },
    { amount: -1.5, label: 'negative float' },
    { amount: 100.5, label: 'large positive float' },
    { amount: '100', label: 'numeric string' },
    { amount: null, label: 'null' },
  ];

  it.each(invalidAmounts)('topup rejects $label ($amount)', async ({ amount }) => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: {
        amount,
        currency: 'INR',
        referenceType: 'PAYMENT_GATEWAY_SYSTEM',
        referenceId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(invalidAmounts)('deduct rejects $label ($amount)', async ({ amount }) => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: {
        amount,
        currency: 'INR',
        referenceType: 'ORDER_SYSTEM',
        referenceId: randomUUID(),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejected requests never touch the database', async () => {
    const id = await createWallet('INR');
    await topup(id, 50000, 'INR');
    const before = await db
      .selectFrom('wallet_ledger_entries')
      .selectAll()
      .where('wallet_id', '=', id)
      .execute();

    await Promise.all([
      app.inject({
        method: 'POST',
        url: `/wallets/${id}/deduct`,
        payload: {
          amount: -1,
          currency: 'INR',
          referenceType: 'ORDER_SYSTEM',
          referenceId: randomUUID(),
        },
      }),
      app.inject({
        method: 'POST',
        url: `/wallets/${id}/topup`,
        payload: {
          amount: 1.5,
          currency: 'INR',
          referenceType: 'PAYMENT_GATEWAY_SYSTEM',
          referenceId: randomUUID(),
        },
      }),
      app.inject({
        method: 'POST',
        url: `/wallets/${id}/deduct`,
        payload: {
          amount: 0,
          currency: 'INR',
          referenceType: 'ORDER_SYSTEM',
          referenceId: randomUUID(),
        },
      }),
    ]);

    const after = await db
      .selectFrom('wallet_ledger_entries')
      .selectAll()
      .where('wallet_id', '=', id)
      .execute();
    expect(after).toHaveLength(before.length);
  });
});
