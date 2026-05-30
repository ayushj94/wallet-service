/**
 * Order Service stub.
 *
 * Pretends to be the upstream Order Service. Calls the Wallet Service's /deduct
 * endpoint to deduct money before "confirming" an order.
 *
 * Demonstrates:
 *   - Normal happy-path deduction (amount of 10000 minor units of whatever
 *     currency the wallet is in — ₹100, $100, etc.).
 *   - Idempotency: re-sending the same order_id (as reference_id under the
 *     ORDER_SYSTEM reference_type) returns the same ledger entry without
 *     double-deducting.
 *   - Failure path: insufficient balance is surfaced cleanly.
 *
 * The stub starts by fetching the wallet's balance to discover its currency,
 * then uses that currency in the deduct call. No currency is hardcoded — a
 * real Order Service would also know which currency the wallet operates in
 * before issuing instructions to the wallet service.
 *
 * Usage:
 *   tsx order-service-stub/place-order.ts <wallet-id> [--retry]
 */
import { randomUUID } from 'node:crypto';

const WALLET_BASE_URL = process.env.WALLET_BASE_URL ?? 'http://localhost:8080';
const AMOUNT_MINOR_UNITS = 10000;

interface BalanceResponse {
  walletId: string;
  balance: number;
  currency: string;
}

interface DeductResponse {
  entry: { id: string; amount: number; balanceAfter: number };
  balance: number;
  currency: string;
  idempotent: boolean;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

async function fetchWalletCurrency(walletId: string): Promise<string> {
  const res = await fetch(`${WALLET_BASE_URL}/wallets/${walletId}/balance`);
  if (res.status === 404) {
    console.error(`[order-service] Wallet ${walletId} not found`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`[order-service] Failed to read wallet (${res.status})`);
    process.exit(1);
  }
  const body = (await res.json()) as BalanceResponse;
  return body.currency;
}

async function callDeduct(
  walletId: string,
  orderId: string,
  currency: string,
): Promise<{ status: number; body: DeductResponse | ErrorResponse }> {
  const res = await fetch(`${WALLET_BASE_URL}/wallets/${walletId}/deduct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      amount: AMOUNT_MINOR_UNITS,
      currency,
      referenceType: 'ORDER_SYSTEM',
      referenceId: orderId,
    }),
  });
  return { status: res.status, body: (await res.json()) as DeductResponse | ErrorResponse };
}

async function placeOrder(walletId: string, opts: { retry: boolean }): Promise<void> {
  const currency = await fetchWalletCurrency(walletId);
  console.log(`[order-service] Wallet ${walletId} is in ${currency}`);

  const orderId = `order-${randomUUID()}`;
  console.log(`[order-service] Placing order ${orderId}`);

  const { status, body } = await callDeduct(walletId, orderId, currency);
  if (status >= 400) {
    const err = body as ErrorResponse;
    console.error(
      `[order-service] Deduct failed (${status} ${err.error.code}): ${err.error.message}`,
    );
    console.error(`[order-service] Order ${orderId} REJECTED`);
    process.exit(1);
  }

  const ok = body as DeductResponse;
  console.log(
    `[order-service] Deduct OK — ledger entry ${ok.entry.id}, balance now ${ok.balance} ${ok.currency}`,
  );
  console.log(`[order-service] Order ${orderId} CONFIRMED`);

  if (opts.retry) {
    console.log('\n[order-service] Simulating network retry — same order_id, must be idempotent');
    const retry = await callDeduct(walletId, orderId, currency);
    const r = retry.body as DeductResponse;
    if (retry.status >= 400) {
      console.error('[order-service] Retry unexpectedly failed:', retry.body);
      process.exit(1);
    }
    console.log(
      `[order-service] Retry response — idempotent=${r.idempotent}, same entry id=${r.entry.id === ok.entry.id}, balance still ${r.balance}`,
    );
    if (!r.idempotent || r.entry.id !== ok.entry.id || r.balance !== ok.balance) {
      console.error('[order-service] Idempotency check FAILED');
      process.exit(1);
    }
    console.log('[order-service] Idempotency check PASSED');
  }
}

const walletId = process.argv[2];
if (!walletId) {
  console.error('Usage: tsx order-service-stub/place-order.ts <wallet-id> [--retry]');
  process.exit(1);
}
const retry = process.argv.includes('--retry');

placeOrder(walletId, { retry }).catch((err) => {
  console.error(err);
  process.exit(1);
});
