/**
 * Order Service stub.
 *
 * Pretends to be the Order Service. Calls the Wallet Service's /deduct endpoint
 * to reserve ₹100 before "confirming" an order.
 *
 * Demonstrates:
 *   - Normal happy-path deduction.
 *   - Idempotency: re-sending the same order_id (used as the idempotency key)
 *     gives back the same transaction without double-deducting.
 *   - Failure path: insufficient balance is surfaced cleanly.
 *
 * Usage:
 *   tsx order-service-stub/place-order.ts <wallet-id> [--retry]
 */
import { randomUUID } from 'node:crypto';

const WALLET_BASE_URL = process.env.WALLET_BASE_URL ?? 'http://localhost:8080';

interface DeductResponse {
  transaction: { id: string; amountPaise: number; balanceAfterPaise: number };
  balancePaise: number;
  idempotent: boolean;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

async function callDeduct(walletId: string, orderId: string): Promise<{ status: number; body: DeductResponse | ErrorResponse }> {
  const res = await fetch(`${WALLET_BASE_URL}/wallets/${walletId}/deduct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': orderId },
    body: JSON.stringify({ amountPaise: 10000, reference: orderId }),
  });
  return { status: res.status, body: (await res.json()) as DeductResponse | ErrorResponse };
}

async function placeOrder(walletId: string, opts: { retry: boolean }): Promise<void> {
  const orderId = `order-${randomUUID()}`;
  console.log(`[order-service] Placing order ${orderId} for wallet ${walletId}`);

  const { status, body } = await callDeduct(walletId, orderId);
  if (status >= 400) {
    const err = body as ErrorResponse;
    console.error(`[order-service] Deduct failed (${status} ${err.error.code}): ${err.error.message}`);
    console.error(`[order-service] Order ${orderId} REJECTED`);
    process.exit(1);
  }

  const ok = body as DeductResponse;
  console.log(`[order-service] Deduct OK — txn ${ok.transaction.id}, balance now ${ok.balancePaise} paise`);
  console.log(`[order-service] Order ${orderId} CONFIRMED`);

  if (opts.retry) {
    console.log('\n[order-service] Simulating network retry — same order_id, must be idempotent');
    const retry = await callDeduct(walletId, orderId);
    const r = retry.body as DeductResponse;
    if (retry.status >= 400) {
      console.error('[order-service] Retry unexpectedly failed:', retry.body);
      process.exit(1);
    }
    console.log(
      `[order-service] Retry response — idempotent=${r.idempotent}, same txn id=${r.transaction.id === ok.transaction.id}, balance still ${r.balancePaise}`,
    );
    if (!r.idempotent || r.transaction.id !== ok.transaction.id || r.balancePaise !== ok.balancePaise) {
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
