/**
 * Order Service stub.
 *
 * Pretends to be the upstream Order Service. Calls the Wallet Service's /deduct
 * endpoint to reserve ₹100 before "confirming" an order.
 *
 * Demonstrates:
 *   - Normal happy-path deduction.
 *   - Idempotency: re-sending the same order_id (as reference_id under the
 *     ORDER_SYSTEM reference_type) returns the same ledger entry without
 *     double-deducting.
 *   - Failure path: insufficient balance is surfaced cleanly.
 *
 * Usage:
 *   tsx order-service-stub/place-order.ts <wallet-id> [--retry]
 */
import { randomUUID } from 'node:crypto';

const WALLET_BASE_URL = process.env.WALLET_BASE_URL ?? 'http://localhost:8080';

interface DeductResponse {
  entry: { id: string; amount: number; balanceAfter: number };
  balance: number;
  currency: string;
  idempotent: boolean;
}

interface ErrorResponse {
  error: { code: string; message: string };
}

async function callDeduct(
  walletId: string,
  orderId: string,
): Promise<{ status: number; body: DeductResponse | ErrorResponse }> {
  const res = await fetch(`${WALLET_BASE_URL}/wallets/${walletId}/deduct`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      amount: 10000,
      referenceType: 'ORDER_SYSTEM',
      referenceId: orderId,
    }),
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
  console.log(
    `[order-service] Deduct OK — ledger entry ${ok.entry.id}, balance now ${ok.balance} ${ok.currency}`,
  );
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
