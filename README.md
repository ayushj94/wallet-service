# Prepaid Wallet Service

A small HTTP service that owns customer wallet balances and records every money movement
as an append-only ledger. Take-home submission.

**Stack:** Node 20, TypeScript, Fastify, MySQL 8, Kysely (type-safe SQL builder), Vitest.

---

## Quick start (Docker)

```bash
docker compose up --build
```

That brings up MySQL, runs the schema migration (via MySQL's `docker-entrypoint-initdb.d`),
then starts the service on `http://localhost:8080`.

Health check:

```bash
curl localhost:8080/health
```

## Quick start (without Docker)

```bash
# 1. Point at any MySQL 8 instance via .env
cp .env.example .env
# edit .env if your local MySQL has different creds

# 2. Install + migrate + run
npm install
npm run migrate
npm run dev
```

## Try it

```bash
# create a wallet
WALLET=$(curl -s -X POST localhost:8080/wallets \
  -H 'content-type: application/json' \
  -d '{"customerId":"acme-corp"}' | jq -r .id)

# top up ₹500
curl -s -X POST localhost:8080/wallets/$WALLET/topup \
  -H 'content-type: application/json' \
  -d '{"amountPaise":50000,"idempotencyKey":"topup-1"}'

# deduct ₹100 (simulating an order)
curl -s -X POST localhost:8080/wallets/$WALLET/deduct \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-abc-123' \
  -d '{"amountPaise":10000,"reference":"order-abc-123"}'

# replay the same deduct — same transaction, balance unchanged
curl -s -X POST localhost:8080/wallets/$WALLET/deduct \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-abc-123' \
  -d '{"amountPaise":10000}'

# balance + history
curl -s localhost:8080/wallets/$WALLET/balance
curl -s localhost:8080/wallets/$WALLET/transactions
```

### Order Service stub

A small script that pretends to be the Order Service and demonstrates idempotency under retry:

```bash
npx tsx order-service-stub/place-order.ts <wallet-id> --retry
```

---

## API

| Method | Path                          | Body / Headers                                                          | Description                                  |
| ------ | ----------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| POST   | `/wallets`                    | `{ "customerId": string }`                                              | Create a wallet                              |
| POST   | `/wallets/:id/topup`          | `{ "amountPaise": int, "idempotencyKey": string, "reference"?: string }` | Add funds                                    |
| POST   | `/wallets/:id/deduct`         | same as topup; `amountPaise` defaults to 10000 (₹100)                    | Deduct funds (idempotent)                    |
| GET    | `/wallets/:id/balance`        | —                                                                       | Current balance                              |
| GET    | `/wallets/:id/transactions`   | `?limit=N` (default 100, max 500)                                       | Ledger history, newest first                 |

`idempotencyKey` can also be passed via the `Idempotency-Key` HTTP header.

### Status codes

| Code | When                                                                 |
| ---- | -------------------------------------------------------------------- |
| 201  | Resource created (wallet, transaction)                               |
| 200  | Idempotent replay — returns the prior transaction unchanged          |
| 400  | Validation error (missing field, non-positive amount, …)             |
| 404  | Wallet not found                                                     |
| 422  | Insufficient balance on deduct                                       |
| 409  | Idempotency conflict (backstop only — see "Idempotency" below)       |

---

## Data model

```
wallets                                    transactions
─────────────────────────                  ──────────────────────────────────
id                CHAR(36) PK              id                  CHAR(36) PK
customer_id       VARCHAR UNIQUE           wallet_id           CHAR(36) FK→wallets
balance_paise     BIGINT                   type                ENUM(TOPUP, DEDUCT)
created_at        TIMESTAMP                amount_paise        BIGINT (always positive)
updated_at        TIMESTAMP                balance_after_paise BIGINT (snapshot for audit)
                                           idempotency_key     VARCHAR
CHECK (balance_paise >= 0)                 reference           VARCHAR NULL
                                           created_at          TIMESTAMP(3)

                                           UNIQUE (wallet_id, idempotency_key)
                                           CHECK  (amount_paise > 0)
                                           CHECK  (balance_after_paise >= 0)
```

Key choices:

- **Money in paise (integer), never floats.** No rounding drift, no decimal-versus-binary
  surprises. Display formatting is a client concern.
- **`amount_paise` is always positive**; `type` carries the direction. Easier to query and
  read than signed amounts.
- **`balance_after_paise` snapshot on each transaction.** Lets us verify the invariant
  `SUM(signed amounts) == wallets.balance_paise` cheaply, and makes the ledger
  self-describing — you can reconstruct any past balance without replaying logic.
- **`CHECK (balance_paise >= 0)`** at the DB layer. The application enforces this too, but
  the DB constraint is a defense-in-depth backstop — if an application bug ever tries to
  write a negative balance, MySQL rejects it.
- **`UNIQUE (wallet_id, idempotency_key)`.** Idempotency keys are scoped per wallet so two
  customers can use overlapping keys without conflict.

---

## Correctness: the two hard cases

### 1. Concurrent deducts on the same wallet

If two `/deduct` requests arrive at the same time for a wallet with ₹100, only one must
succeed. The naive implementation (read balance, check, write) has a TOCTOU race that lets
both pass.

The fix is `SELECT ... FOR UPDATE` inside a transaction: the first request takes a
row-level lock on the wallet, the second blocks until the first commits, then sees the
updated balance and either proceeds or fails cleanly. MySQL InnoDB does this in milliseconds.

Belt-and-braces: there's also a `CHECK (balance_paise >= 0)` constraint, so if the
application logic were ever bypassed the DB would still reject the write.

See `src/services/wallet-service.ts` → `applyMutation`. The lock acquisition is the very
first thing inside the transaction.

### 2. Idempotent deduct (and topup)

The Order Service may retry a `/deduct` call after a network blip; we must charge once.

The approach:

1. Inside the same transaction, **after taking the wallet lock**, look up the
   `(wallet_id, idempotency_key)` pair.
2. If a transaction with that key already exists, return its data with `idempotent: true`.
3. Otherwise, insert the new transaction and update the balance.

Locking the wallet **before** the idempotency check is what makes concurrent retries safe:
two requests with the same key serialize on the wallet row, so the second one sees the
first's committed transaction when it does its idempotency lookup.

The `UNIQUE (wallet_id, idempotency_key)` constraint is a defense-in-depth backstop —
the application path shouldn't hit it, but if a bug ever broke the lock-then-check order,
the DB would reject the duplicate insert and the error handler maps it to a clean 409.

**The spec only required `/deduct` to be idempotent, but I made `/topup` idempotent too**
using the same mechanism. Topup retries are just as real (payment-gateway webhooks, frontend
retries) and a double-credit is arguably worse than a double-debit. Same code path, no
special cases.

---

## Testing methodology

The test suite (`tests/wallet.test.ts`) runs against a real MySQL instance — not an in-memory
mock — because the correctness questions this service is built around (row locks, unique
constraints, isolation) are precisely what mocks would paper over.

What it covers:

| Class of test          | What it asserts                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Happy path             | Create → topup → deduct → balance/history reflects every operation                       |
| Balance constraint     | Deduct rejected on empty/insufficient wallet; balance unchanged. Exact-balance deduct OK |
| Idempotency (deduct)   | Same key returns same transaction, balance unchanged                                     |
| Idempotency (topup)    | Same — extra safety not in the spec                                                      |
| Idempotency via header | `Idempotency-Key` HTTP header works in addition to body field                            |
| **Concurrent deducts** | 10 parallel requests on a ₹300 wallet → exactly 3 succeed, 7 fail with 422               |
| **Concurrent retries** | 10 parallel requests with same idempotency key → exactly one transaction created         |
| **Chaos / invariant**  | 50 mixed parallel ops → assert `SUM(signed amounts) == wallets.balance` afterwards       |
| Validation             | Missing fields, non-positive amounts → 400                                                |
| Not found              | Unknown wallet → 404 on all paths                                                         |

Run:

```bash
# bring up MySQL first
docker compose up -d mysql

# in another terminal
npm test
```

The chaos test is the most valuable one — it's the test I'd run after any change to the
mutation path. If `SUM(signed amounts) == wallets.balance` ever fails, something is
fundamentally wrong with the locking or idempotency.

---

## Decisions and trade-offs

- **MySQL over an in-memory store.** The whole assignment is a concurrency-correctness
  problem. An in-memory map with a JS lock "works" but it doesn't demonstrate the actual
  production tools (row locking, unique constraints, transaction isolation) — and it can't
  survive a process restart.
- **Kysely over an ORM.** I considered Sequelize and Prisma. Sequelize hides
  `FOR UPDATE` behind options-bag config; Prisma adds a code-generation step. Kysely is a
  thin type-safe layer over raw SQL — the lock and the idempotency lookup read like SQL,
  which is what you want when correctness depends on exactly which SQL runs.
- **No Redis.** Considered Redis for distributed locking; rejected. MySQL's row lock IS
  the source of truth — adding Redis on top creates a TOCTOU gap (Redis lock and DB state
  can drift) without making anything safer. Redis would be a great fit for
  rate-limiting-per-wallet or hot-balance read caching, neither of which the assignment
  needs.
- **Idempotency stored on the transaction row, not a separate table.** Stripe-style
  separate `idempotency_keys` tables let you cache the full response body for byte-exact
  replay. Here, the response is small and derivable from the transaction row, so an extra
  table would be over-engineering.
- **`amountPaise` accepted on `/deduct` even though spec fixes it at ₹100.** Defaults to
  10000 paise when missing, so the spec's "₹100 per order" flow works with no body. But
  it's parameterised so tests can exercise different amounts.

---

## What I'd do with more time

- **Per-wallet rate limiting** with Redis — protect against runaway clients or abuse.
- **Reconciliation job** that periodically asserts `SUM(transactions) == wallets.balance`
  across every wallet and alerts if it drifts.
- **Optimistic-locking read path for balance** — currently `GET /balance` reads the
  `wallets` row directly, which is fine, but for very high read-to-write ratios I'd cache
  it in Redis with invalidation on every successful mutation.
- **Background expiry of stale idempotency keys.** Right now they live forever; in
  production I'd TTL them at e.g. 24h since retries beyond that don't happen.
- **Structured request IDs + tracing.** Fastify's `req.id` is fine for local dev; in prod
  I'd plumb OpenTelemetry through.
- **A proper migrations framework.** The current `migrations/*.sql` + auto-run on MySQL
  startup is fine for v1 but doesn't track applied migrations. `kysely-migrator` or
  `node-pg-migrate`-style would be the upgrade.
- **Read-replica support in Kysely** — split `GET` traffic onto a replica with a small
  lag-aware fallback to primary.

---

## Project layout

```
.
├── docker-compose.yml          # MySQL + service, one command to start
├── Dockerfile                  # multi-stage build for the service image
├── migrations/
│   └── 001_init.sql            # schema (auto-runs on first MySQL boot)
├── order-service-stub/
│   └── place-order.ts          # demonstrates /deduct with retry
├── src/
│   ├── server.ts               # entrypoint, graceful shutdown
│   ├── app.ts                  # Fastify wiring, error mapping
│   ├── config.ts               # env vars
│   ├── db/
│   │   ├── index.ts            # Kysely + mysql2 pool
│   │   ├── schema.ts           # row types
│   │   └── migrate.ts          # CLI: run SQL files in order
│   ├── routes/
│   │   └── wallets.ts          # HTTP layer (validation, DTO shaping)
│   ├── services/
│   │   └── wallet-service.ts   # business logic — locking + idempotency
│   └── errors.ts               # AppError → status code mapping
└── tests/
    ├── setup.ts                # shared Fastify + DB lifecycle
    └── wallet.test.ts          # happy / balance / idempotency / concurrency / chaos
```
