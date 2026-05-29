import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { app } from './setup';
import { db } from '../src/db';
import type { Currency } from '../src/db/schema';

// All helpers require `currency` explicitly — no defaults. Financial code paths
// should never assume a currency.

async function createWallet(currency: Currency): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/wallets',
    payload: { customerId: `cust-${randomUUID()}`, currency },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
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
    payload: { amount, currency, referenceType: 'PAYMENT_SYSTEM', referenceId: refId },
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
    expect(ledger.json().entries.map((e: { entryType: string }) => e.entryType).sort()).toEqual([
      'CREDIT',
      'DEBIT',
    ]);
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

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);
    expect(second.json().entry.id).toBe(first.json().entry.id);
    // Replay returns the balance as it was right after the original op,
    // not the current balance — true idempotent semantics.
    expect(second.json().balance).toBe(first.json().balance);

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
    expect(second.json().idempotent).toBe(true);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(50000);
  });

  it('same reference_id under different reference_type is treated as distinct', async () => {
    const id = await createWallet('INR');
    await topup(id, 100000, 'INR');

    const sameId = randomUUID();
    const r1 = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: { amount: 10000, currency: 'INR', referenceType: 'ORDER_SYSTEM', referenceId: sameId },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: { amount: 10000, currency: 'INR', referenceType: 'LOAN_SYSTEM', referenceId: sameId },
    });

    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    expect(r1.json().entry.id).not.toBe(r2.json().entry.id);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balance).toBe(80000); // both debits applied
  });
});

describe('concurrency', () => {
  it('serializes concurrent debits — only as many succeed as the balance allows', async () => {
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
    const entryIds = new Set(ok.map((r) => r.json().entry.id));
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

    const wallet = await db.selectFrom('wallets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
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
      payload: { amount: 10000, referenceType: 'PAYMENT_SYSTEM', referenceId: randomUUID() },
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
});

describe('amount must be a positive integer', () => {
  // These are caught by Fastify's JSON-schema validation before the route handler
  // ever runs — so a malformed request never reaches the database.
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
      payload: { amount, currency: 'INR', referenceType: 'PAYMENT_SYSTEM', referenceId: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
  });

  it.each(invalidAmounts)('deduct rejects $label ($amount)', async ({ amount }) => {
    const id = await createWallet('INR');
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      payload: { amount, currency: 'INR', referenceType: 'ORDER_SYSTEM', referenceId: randomUUID() },
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
        payload: { amount: -1, currency: 'INR', referenceType: 'ORDER_SYSTEM', referenceId: randomUUID() },
      }),
      app.inject({
        method: 'POST',
        url: `/wallets/${id}/topup`,
        payload: { amount: 1.5, currency: 'INR', referenceType: 'PAYMENT_SYSTEM', referenceId: randomUUID() },
      }),
      app.inject({
        method: 'POST',
        url: `/wallets/${id}/deduct`,
        payload: { amount: 0, currency: 'INR', referenceType: 'ORDER_SYSTEM', referenceId: randomUUID() },
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
