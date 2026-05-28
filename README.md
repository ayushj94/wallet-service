<div align="center">

# Prepaid Wallet Service

**A small, careful service that holds customer money — and never loses a paise of it.**

<sub>Take-home submission · Node 20 · TypeScript · Fastify · Postgres 16 · Kysely</sub>

</div>

---

## What this is

A logistics platform's customers prepay money into a wallet. Every order debits a fixed
amount; topups credit it. Two unbreakable rules:

> A wallet must never go negative.
> A retried request must never charge twice.

Everything in this repo is built around honouring those two rules — under load, under
retries, under concurrent activity on the same wallet.

---

## Run it

```bash
docker compose up --build
```

That brings up Postgres, applies the schema on first boot, and starts the service on
[localhost:8080](http://localhost:8080).

<details>
<summary><b>Without Docker</b> (if you'd rather run against your own Postgres)</summary>

```bash
cp .env.example .env       # point at your Postgres
npm install
npm run migrate            # applies migrations/001_init.sql
npm run dev
```
</details>

### Try it out

```bash
# Create a wallet
WALLET=$(curl -s -X POST localhost:8080/wallets \
  -H 'content-type: application/json' \
  -d '{"customerId":"acme-corp"}' | jq -r .id)

# Top up ₹500
curl -s -X POST localhost:8080/wallets/$WALLET/topup \
  -H 'content-type: application/json' \
  -d '{"amountPaise":50000,"idempotencyKey":"topup-1"}'

# Place an order — deduct ₹100
curl -s -X POST localhost:8080/wallets/$WALLET/deduct \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-abc-123' \
  -d '{"referenceId":"order-abc-123"}'

# Retry the same order — same response, balance unchanged
curl -s -X POST localhost:8080/wallets/$WALLET/deduct \
  -H 'idempotency-key: order-abc-123' \
  -d '{}'

# Check balance and ledger
curl -s localhost:8080/wallets/$WALLET/balance
curl -s localhost:8080/wallets/$WALLET/transactions
```

### Order Service stub

A script that pretends to be the upstream Order Service. Demonstrates idempotency by
retrying the same order_id and checking it doesn't double-charge:

```bash
npx tsx order-service-stub/place-order.ts <wallet-id> --retry
```

---

## API at a glance

| Method | Path | What it does |
| ------ | ---- | ------------ |
| `POST` | `/wallets` | Open a wallet for a customer |
| `POST` | `/wallets/:id/topup` | Add money (idempotent) |
| `POST` | `/wallets/:id/deduct` | Take money for an order (idempotent) |
| `GET`  | `/wallets/:id/balance` | What's in the wallet right now |
| `GET`  | `/wallets/:id/transactions` | The ledger — every credit and debit |

`idempotencyKey` may be passed as a JSON field or as the `Idempotency-Key` HTTP header.

<details>
<summary><b>Response codes</b></summary>

| Code | When |
| ---- | ---- |
| `201` | A new wallet or ledger entry was created |
| `200` | A retry of a previous request — same answer as before |
| `400` | The request itself is malformed (missing field, non-positive amount, …) |
| `404` | Wallet doesn't exist |
| `422` | Not enough money for this deduction |
| `409` | Idempotency-key conflict (a backstop — the service path catches this internally) |

</details>

---

## How the data is shaped

```
┌────────────────────────┐         ┌──────────────────────────────────┐
│ wallets                │         │ ledger_entries                   │
│ ────────────────────── │         │ ──────────────────────────────── │
│ id              UUID   │◀────────│ wallet_id            UUID        │
│ customer_id     UNIQUE │         │ id                   UUID        │
│ balance_paise   BIGINT │         │ entry_type           CREDIT/DEBIT│
│ created_at, updated_at │         │ amount_paise         BIGINT > 0  │
│                        │         │ balance_after_paise  BIGINT      │
│ CHECK balance ≥ 0      │         │ idempotency_key      VARCHAR     │
└────────────────────────┘         │ reference_id         VARCHAR?    │
                                   │ created_at           TIMESTAMPTZ │
                                   │                                  │
                                   │ UNIQUE(wallet_id, idem_key)      │
                                   │ CHECK amount > 0                 │
                                   │ CHECK balance_after ≥ 0          │
                                   └──────────────────────────────────┘
```

A few choices worth pointing out:

- **Money is stored in paise**, as integers. Floats and money don't mix — you'd accumulate
  tiny rounding errors over time and one day discover ₹0.0000001 missing from a customer.
- **Every entry stores the balance *after* it was applied**. Means you can audit any past
  moment without replaying the whole history, and the latest entry's `balance_after_paise`
  always agrees with `wallets.balance_paise`.
- **`amount_paise` is always positive**; direction lives in `entry_type`. Easier to read,
  easier to query ("show me all credits this month").
- **`UNIQUE (wallet_id, idempotency_key)`** is the safety net that makes retries safe.

---

## The two interesting design decisions

This section is the heart of the README. Everything else is plumbing.

### 1. Where does the balance live?

We could have built this three ways. Each one is a real choice you'll see in different
production systems.

#### Option A — Compute the balance from the ledger every time

The ledger is already an append-only record of every credit and debit. So why store the
balance separately at all? Just `SUM(credits) - SUM(debits)` whenever someone asks.

It's clean and elegant. There's only one source of truth, and it can never drift from
itself.

The problem isn't the read path — it's the **write path**.

Every `/deduct` has to first answer: "is there enough money?" That means computing the
current balance *before* the mutation. So the deduct path *also* has to scan the entire
ledger — every single time, for every order.

You can't cache your way out of this. The deduct needs the **authoritative,
up-to-the-microsecond** balance to make a correctness decision. A stale cache could let
two orders both pass a balance check that's actually only good for one — and you've
double-spent.

| What | Reads | Writes |
| ---- | ----- | ------ |
| Cost | Slow (O of total entries) | **Slow (same scan)** |
| Cacheable? | Yes — happy path is fast after warmup | **No** — cache can't be trusted for correctness |

So caching hides the read problem but does nothing for the write problem. For an active
wallet that does a thousand orders a day, this design buckles under its own success.

#### Option B — Keep a `balance` column on the wallet, updated with every entry

This is what we do. Every time we write a ledger entry, we update `wallets.balance_paise`
to match — in the same database transaction, so they can't get out of step.

| What | Reads | Writes |
| ---- | ----- | ------ |
| Cost | One indexed lookup | One indexed lookup + one update |
| Drift risk | Impossible — the transaction makes them atomic | Same |

`/balance` becomes a single primary-key read. The deduct path reads the current balance,
checks it, writes the new value — all in one tightly-scoped transaction.

The only theoretical concern is drift between the column and the ledger. But because every
change happens in the same transaction, drift would require a database bug, not a logic
bug. The chaos test (`SUM(signed amounts) == wallets.balance`) is the canary — if anyone
ever moves the wallet update outside the transaction, that test screams.

#### Option C — Hybrid: store balance, but derive it from the latest ledger entry

We already write `balance_after_paise` to every ledger entry. So you could drop the
`wallets.balance_paise` column entirely and read `balance_after_paise` from the most
recent ledger entry for the wallet. O(1) with an index on `(wallet_id, created_at DESC)`.

It works. It's slightly purer. But it has two downsides:
- A wallet that grows additional fields (status, tier, daily-limit, frozen-until) loses
  its natural home — those don't belong on a ledger entry.
- "Show me all wallets with balance over ₹10000" stops being a simple index scan.

So we stick with Option B: a real balance column, kept honest by atomic transactions.

---

### 2. How do we stop two requests from spending the same money?

Imagine a wallet has ₹100, and two `/deduct` requests for ₹100 arrive at the exact same
millisecond. Both read the balance (₹100), both decide they're allowed to proceed, both
debit. The wallet now reads ₹-100 — a hole the business has to absorb.

This is the central correctness question. There are three honest ways to solve it.

#### Pessimistic locking — "everyone wait your turn"

The first request to arrive takes a **row-level lock** on the wallet — telling the database
"nobody else touches this row until I'm done." The second request has to wait. When the
first commits, the second wakes up, sees the new balance, and either proceeds or fails.

```
Request A: lock → read balance → debit → commit → release
Request B:            wait...........................wait → lock → read → debit
```

Pros: Simple to reason about. No retries, no rollbacks, no surprises. Easy to extend with
additional checks (status, tier, limits) inside the locked section.

Cons: Every request pays the lock cost, even when there's no actual contention. On a quiet
wallet — which is most of them — that's a tax you didn't need to pay.

#### Optimistic locking — "race ahead, undo if we collide"

Try to mutate without locking first. The mutation itself is atomic — Postgres lets you say
"update the balance, but only if it would stay non-negative, and tell me the new value."
If two requests race, **one wins, one comes back with `0 rows affected`** and knows it lost.

```
Request A:   try-debit (success) → write ledger → done
Request B:   try-debit (success) → write ledger → conflict!  → roll back → look up A's result
```

Pros: When there's no contention (which is most of the time for a customer wallet), this
saves a query per request. Faster average-case throughput.

Cons: When there *is* contention, the loser pays extra — it rolled back work it shouldn't
have started, and has to look up the winner's result. Also slightly more code paths to
understand.

#### Double-checked — "peek first, then lock if it looks promising"

A clever optimization: do a quick, lockless read of the balance first. If it's clearly
insufficient, reject right away without bothering to take a lock. If it looks promising,
take the lock and check properly.

```
Request: read balance (no lock) → not enough? reject
                                → enough?     lock → read again → debit
```

Pros: Saves a lock for guaranteed-to-fail requests.

Cons: This is a real-world example of premature optimization. The "expensive" lock isn't
actually expensive — it's microseconds. The extra read costs a network round trip — about
a millisecond. So you've added a guaranteed cost to make a rare case cheaper. The math
doesn't work out unless your lock contention is genuinely high *and* most of those
contenders would have failed anyway. For a wallet service, that's almost never true.

There's also a subtle correctness wrinkle: the lockless read can be stale, leading to
false negatives if a topup commits in between the two reads.

#### So which one did we pick?

**Optimistic** — because customer wallets have very low contention (one person isn't
firing a hundred concurrent orders on themselves), and the happy-path win is worth more
than the rare-case loss.

On a busy B2B logistics wallet with many concurrent ops, the math gets closer — pessimistic
locking has its case there. But even then, you'd want sharded balances long before
single-row contention became a real bottleneck.

| | Happy path (no contention) | Race path (concurrent same key) |
| --- | --- | --- |
| Pessimistic | 4 queries | 4 + 2 queries (loser waits, returns cached) |
| **Optimistic (chosen)** | **3 queries** | 3 + 4 queries + 1 rollback |
| Double-check | 4 + 1 queries | 4 + 2 + 1 queries |

The happy path runs millions of times more often than the conflict path. Optimistic wins.

---

## How idempotency works

When the Order Service retries `/deduct` after a network blip, it sends the **same
idempotency key** (typically `order_id`). The wallet service has to charge once and only
once.

Two layers do this work:

1. **The fast path**: before doing any work, look up `(wallet_id, idempotency_key)` in the
   ledger. If a row exists, we already processed this request — return that row's data and
   stop. This is the case for any retry that arrives after the original committed (which
   is almost all of them — retries are typically delayed by seconds).

2. **The unique constraint**: `UNIQUE (wallet_id, idempotency_key)` is the safety net for
   the rare case where two requests with the same key are truly in flight at the same
   moment. The fast path can't catch them — neither has committed yet. So both proceed,
   both try to insert a ledger row, the database rejects the second one, and our code
   rolls back its wallet update and fetches the winner's result.

The spec only asked for `/deduct` to be idempotent, but we made `/topup` idempotent too.
Real-world topups also retry — payment-gateway webhooks fire twice, customers refresh the
checkout page, etc. Same code path, same mechanism, same guarantees. A double-credit is at
least as bad as a double-debit.

---

## How we test it

The test suite runs against a real Postgres instance — not a mock — because the questions
this service has to answer (does the row lock work? does the unique constraint catch
races?) are precisely what a mock would lie about.

| What it checks | Why it matters |
| -------------- | -------------- |
| Happy path through every endpoint | The boring "does it work at all" baseline |
| Insufficient balance is rejected | The headline correctness rule |
| Exact-balance deduct succeeds | Off-by-one boundary check |
| Replay of `/deduct` returns the same entry | Idempotency, the spec's hard requirement |
| Replay of `/topup` returns the same entry | Idempotency we added beyond the spec |
| `Idempotency-Key` header works alongside body field | Two transports, one outcome |
| **10 concurrent deducts on a ₹300 wallet** | Exactly 3 succeed, 7 fail with 422. The locking story. |
| **10 concurrent same-key retries** | Exactly 1 ledger entry is created. The idempotency story. |
| **50-op chaos run** | `SUM(signed amounts) == wallets.balance` after the dust settles |
| Validation errors return 400 | Fastify JSON-schema rejects malformed input |
| Unknown wallet returns 404 | Standard not-found behaviour |

```bash
docker compose up -d postgres   # start the DB
npm test                        # run the suite
```

The chaos test is the most valuable one. If `SUM(ledger) == balance` ever fails, it means
the atomicity between the ledger insert and the wallet update has broken — that's a
canary worth keeping forever.

---

## What I'd do with more time

- **Per-wallet rate limiting** with Redis — protect against runaway scripts hammering one
  wallet.
- **Reconciliation job**, run hourly, that asserts `SUM(ledger) == balance` across every
  wallet and pages on-call if it ever drifts.
- **More ledger entry types** — `REFUND`, `ADJUSTMENT`, `BONUS_CREDIT`. The shape of the
  ledger already accommodates this; only the enum needs new values.
- **Settlement states** — real wallets often have entries in `PENDING` before they reach
  `COMPLETED`, to model in-flight payments. Out of scope today but the shape supports it.
- **Read replica for balance lookups** — current design points everything at the primary;
  a small lag-aware fallback would let `GET /balance` scale further.
- **Idempotency-key expiry** — they currently live forever. In production, TTL them at
  24 hours since retries beyond that don't happen.
- **OpenTelemetry tracing** — Fastify's `req.id` works for local dev; production needs
  proper distributed tracing.

---

## Project layout

```
.
├── docker-compose.yml             # Postgres + service in one command
├── Dockerfile                     # multi-stage service image
├── migrations/
│   └── 001_init.sql               # schema, applied on first DB boot
├── order-service-stub/
│   └── place-order.ts             # the upstream caller, with retry simulation
├── src/
│   ├── server.ts                  # entrypoint, graceful shutdown
│   ├── app.ts                     # Fastify wiring, error → HTTP mapping
│   ├── config.ts                  # env vars
│   ├── db/
│   │   ├── index.ts               # Kysely + pg pool
│   │   ├── schema.ts              # row types
│   │   └── migrate.ts             # CLI: run SQL files in order
│   ├── routes/
│   │   └── wallets.ts             # HTTP handlers + JSON-schema validation
│   ├── services/
│   │   └── wallet-service.ts      # the heart — optimistic concurrency, idempotency
│   └── errors.ts                  # typed errors → status codes
└── tests/
    ├── setup.ts                   # shared Fastify + DB lifecycle
    └── wallet.test.ts             # happy, balance, idempotency, concurrency, chaos
```
