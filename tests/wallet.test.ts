import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { app } from './setup';
import { db } from '../src/db';

async function createWallet(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/wallets',
    payload: { customerId: `cust-${randomUUID()}` },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function topup(id: string, amount: number, key = randomUUID()): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: `/wallets/${id}/topup`,
    payload: { amountPaise: amount, idempotencyKey: key },
  });
}

async function deduct(id: string, amount = 10000, key = randomUUID()): Promise<ReturnType<typeof app.inject>> {
  return app.inject({
    method: 'POST',
    url: `/wallets/${id}/deduct`,
    payload: { amountPaise: amount, idempotencyKey: key },
  });
}

describe('happy path', () => {
  it('creates wallet, tops up, deducts, returns history', async () => {
    const id = await createWallet();
    expect((await topup(id, 50000)).statusCode).toBe(201);
    expect((await deduct(id, 10000)).statusCode).toBe(201);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(40000);

    const txns = await app.inject({ method: 'GET', url: `/wallets/${id}/transactions` });
    expect(txns.json().transactions).toHaveLength(2);
  });
});

describe('balance constraint', () => {
  it('rejects deduct when balance is insufficient', async () => {
    const id = await createWallet();
    await topup(id, 5000);
    const res = await deduct(id, 10000);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_BALANCE');

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(5000);
  });

  it('rejects deduct on an empty wallet', async () => {
    const id = await createWallet();
    const res = await deduct(id, 10000);
    expect(res.statusCode).toBe(422);
  });

  it('allows deduct of exactly the balance', async () => {
    const id = await createWallet();
    await topup(id, 10000);
    const res = await deduct(id, 10000);
    expect(res.statusCode).toBe(201);
    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(0);
  });
});

describe('idempotency', () => {
  it('replays the same response on duplicate deduct key', async () => {
    const id = await createWallet();
    await topup(id, 50000);

    const key = randomUUID();
    const first = await deduct(id, 10000, key);
    const second = await deduct(id, 10000, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);
    expect(second.json().transaction.id).toBe(first.json().transaction.id);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(40000); // deducted once, not twice
  });

  it('replays the same response on duplicate topup key', async () => {
    const id = await createWallet();
    const key = randomUUID();
    const first = await topup(id, 50000, key);
    const second = await topup(id, 50000, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(50000);
  });

  it('uses Idempotency-Key header when body field is absent', async () => {
    const id = await createWallet();
    await topup(id, 50000);

    const key = randomUUID();
    const r1 = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      headers: { 'idempotency-key': key },
      payload: { amountPaise: 10000 },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deduct`,
      headers: { 'idempotency-key': key },
      payload: { amountPaise: 10000 },
    });

    expect(r1.statusCode).toBe(201);
    expect(r2.json().idempotent).toBe(true);
  });
});

describe('concurrency', () => {
  it('serializes concurrent deducts — only as many succeed as the balance allows', async () => {
    const id = await createWallet();
    await topup(id, 30000); // exactly 3 deducts of 10000

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => deduct(id, 10000, randomUUID())),
    );

    const successes = attempts.filter((r) => r.statusCode === 201);
    const failures = attempts.filter((r) => r.statusCode === 422);

    expect(successes).toHaveLength(3);
    expect(failures).toHaveLength(7);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(0);
  });

  it('concurrent calls with the same idempotency key produce one transaction', async () => {
    const id = await createWallet();
    await topup(id, 50000);

    const key = randomUUID();
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => deduct(id, 10000, key)),
    );

    const ok = attempts.filter((r) => r.statusCode === 201 || r.statusCode === 200);
    expect(ok).toHaveLength(10);

    // Every response references the same transaction id.
    const txnIds = new Set(ok.map((r) => r.json().transaction.id));
    expect(txnIds.size).toBe(1);

    const bal = await app.inject({ method: 'GET', url: `/wallets/${id}/balance` });
    expect(bal.json().balancePaise).toBe(40000); // deducted exactly once
  });
});

describe('ledger invariant', () => {
  it('SUM(signed amounts) == wallets.balance after a chaos run', async () => {
    const id = await createWallet();

    // Random mix of topups, valid deducts, and over-balance deducts in parallel.
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) ops.push(topup(id, 10000, randomUUID()));
    for (let i = 0; i < 30; i++) ops.push(deduct(id, 10000, randomUUID()));
    await Promise.all(ops);

    const wallet = await db.selectFrom('wallets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const txns = await db.selectFrom('transactions').selectAll().where('wallet_id', '=', id).execute();

    const sum = txns.reduce((acc, t) => acc + (t.type === 'TOPUP' ? t.amount_paise : -t.amount_paise), 0);
    expect(sum).toBe(wallet.balance_paise);
    expect(wallet.balance_paise).toBeGreaterThanOrEqual(0);

    // Last transaction's balance_after must equal the wallet's current balance.
    const last = txns.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    if (last) expect(last.balance_after_paise).toBe(wallet.balance_paise);
  });
});

describe('validation and not-found', () => {
  it('rejects missing customerId', async () => {
    const res = await app.inject({ method: 'POST', url: '/wallets', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-positive amount on topup', async () => {
    const id = await createWallet();
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: { amountPaise: 0, idempotencyKey: randomUUID() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects missing idempotency key on mutation', async () => {
    const id = await createWallet();
    const res = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/topup`,
      payload: { amountPaise: 10000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown wallet on deduct', async () => {
    const res = await deduct(randomUUID(), 10000);
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for unknown wallet on balance', async () => {
    const res = await app.inject({ method: 'GET', url: `/wallets/${randomUUID()}/balance` });
    expect(res.statusCode).toBe(404);
  });
});
