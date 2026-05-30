<div align="center">

# 💰 Prepaid Wallet Service

<sub>Node 20 · TypeScript · Fastify · Postgres 16 · Kysely · Vitest</sub>

<br/>

[![CI](https://github.com/ayushj94/wallet-service/actions/workflows/ci.yml/badge.svg)](https://github.com/ayushj94/wallet-service/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.5-3178C6?logo=typescript&logoColor=white)
![Postgres](https://img.shields.io/badge/postgres-16-336791?logo=postgresql&logoColor=white)
![Fastify](https://img.shields.io/badge/fastify-4-000000?logo=fastify&logoColor=white)
![Tests](https://img.shields.io/badge/tests-50_passing-brightgreen)

</div>

<br/>

> 🎯 **At a glance**
>
> - 🚫 **Never go negative.** A wallet's balance cannot drop below zero under any operation.
> - 🔁 **Never charge twice.** Retried requests with the same reference are deduped at the database layer.
> - 🏦 **Source of truth for every dollar.** Owns balances; records every movement to an append-only ledger.
> - 🪟 **Transparent.** Clients can query current balance and the full transaction history through `GET` endpoints.
> - 💱 **Multi-currency.** Five currencies (USD, EUR, GBP, CAD, INR), single currency per wallet today, extensible to cross-currency operations.
> - ✅ **50 tests** covering happy path, balance constraint, idempotency, concurrency races, chaos invariants (the ledger and the balance always agree, no matter the workload), and amount overflow.

---

## 📑 Table of Contents

1. [Prerequisites](#-1-prerequisites)
2. [Run it](#-2-run-it)
3. [Check Health](#-3-check-health)
4. [API Contracts](#-4-api-contracts)
5. [System Design](#-5-system-design)
6. [How we test it](#-6-how-we-test-it)
7. [Project Layout](#-7-project-layout)

---

## 🛠 1. Prerequisites

The fastest path needs **only Docker**. Everything else (Postgres, Node, dependencies, migrations) runs inside containers.

| Path | What you need installed |
| :--- | :--- |
| 🐳 **Docker (recommended)** | Docker Desktop (Mac / Windows) **or** `docker` + `docker compose` on Linux. Nothing else. |
| 🛠 **Manual setup** | Node 20+, npm (bundled with Node), and a running Postgres 16+ instance you can point at via `.env`. |

---

## ⚡ 2. Run it

### 🐳 Docker

```bash
docker compose up --build
```

Brings up Postgres, applies the schema on first boot, starts the service on [localhost:8080](http://localhost:8080).

### 🛠 Manual

```bash
cp .env.example .env       # point at your Postgres
npm install
npm run migrate            # applies migrations/001_init.sql
npm run dev
```

---

## 🩺 3. Check Health

Two endpoints following the standard Kubernetes pattern (`liveness` + `readiness`):

| URL | What it tells you |
| :--- | :--- |
| `GET /health/live` | Process is alive. Always `200 ok` if the service can answer at all. |
| `GET /health/ready` | DB is reachable. Returns `200` if a `SELECT 1` succeeds; `503` if not. |

> 📚 Also useful: `GET /docs` (interactive OpenAPI try-it-out UI), `GET /docs/json` (raw OpenAPI spec).

---

## 🚀 4. API Contracts

Five endpoints. Click any to see the contract and a curl example.

<details>
<summary><b>POST /wallets</b> · Open a wallet for a customer</summary>

<br/>

> Not idempotent. A second request with the same `customerId` returns `409`.

**Request body**

```jsonc
{
  "customerId": "string",   // required, 1 to 64 chars
  "currency": "string"      // required, one of: USD, EUR, GBP, CAD, INR
}
```

**Responses**

<details>
<summary><code>201 Created</code> · Wallet created</summary>

```jsonc
{
  "id": "string",            // UUID
  "customerId": "string",
  "currency": "string",
  "balance": 0,              // integer, minor units of the currency
  "createdAt": "string"      // ISO 8601 timestamp
}
```

</details>

<details>
<summary><code>400 Bad Request</code> · Validation error</summary>

```jsonc
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "string"
  }
}
```

</details>

<details>
<summary><code>409 Conflict</code> · Customer already has a wallet</summary>

```jsonc
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "string"
  }
}
```

</details>

**Sample cURL**

```bash
curl -X POST http://localhost:8080/wallets \
  -H 'content-type: application/json' \
  -d '{"customerId":"acme-corp","currency":"USD"}'
```

</details>

<details>
<summary><b>POST /wallets/:id/topup</b> · Credit money to a wallet</summary>

<br/>

> 🔁 Idempotent on `(walletId, referenceType, referenceId)`.

**Request body**

```jsonc
{
  "amount": "integer",         // required, minor units, 1 to 9_007_199_254_740_991
  "currency": "string",        // required, must match the wallet's currency
  "referenceType": "string",   // required, 1 to 32 chars (e.g. PAYMENT_SYSTEM)
  "referenceId": "string"      // required, 1 to 128 chars (the source instruction ID)
}
```

**Responses**

<details>
<summary><code>201 Created</code> · New credit recorded</summary>

```jsonc
{
  "entry": {
    "id": "string",            // UUID
    "walletId": "string",      // UUID
    "entryType": "string",     // CREDIT or DEBIT
    "amount": "integer",
    "balanceAfter": "integer",
    "referenceType": "string",
    "referenceId": "string",
    "createdAt": "string"      // ISO 8601 timestamp
  },
  "balance": "integer",
  "currency": "string",
  "idempotent": false
}
```

</details>

<details>
<summary><code>200 OK</code> · Idempotent replay of an earlier credit</summary>

Same body as `201`, with `idempotent: true`. The `balance` reflects the value immediately after the original operation, not the current balance.

</details>

<details>
<summary><code>400 Bad Request</code> · Validation error</summary>

```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "string" } }
```

</details>

<details>
<summary><code>404 Not Found</code> · Wallet doesn't exist</summary>

```jsonc
{ "error": { "code": "NOT_FOUND", "message": "string" } }
```

</details>

<details>
<summary><code>422 Unprocessable Entity</code> · Currency mismatch or amount overflow</summary>

```jsonc
{ "error": { "code": "CURRENCY_MISMATCH | AMOUNT_OUT_OF_RANGE", "message": "string" } }
```

</details>

**Sample cURL**

```bash
curl -X POST http://localhost:8080/wallets/<wallet-id>/topup \
  -H 'content-type: application/json' \
  -d '{
    "amount": 50000,
    "currency": "USD",
    "referenceType": "PAYMENT_SYSTEM",
    "referenceId": "payment-001"
  }'
```

</details>

<details>
<summary><b>POST /wallets/:id/deduct</b> · Debit money from a wallet</summary>

<br/>

> 🔁 Idempotent on `(walletId, referenceType, referenceId)`.

**Request body**

```jsonc
{
  "amount": "integer",         // required, minor units, 1 to 9_007_199_254_740_991
  "currency": "string",        // required, must match the wallet's currency
  "referenceType": "string",   // required, 1 to 32 chars (e.g. ORDER_SYSTEM)
  "referenceId": "string"      // required, the source instruction ID
}
```

**Responses**

<details>
<summary><code>201 Created</code> · New debit recorded</summary>

```jsonc
{
  "entry": {
    "id": "string",
    "walletId": "string",
    "entryType": "string",     // DEBIT
    "amount": "integer",
    "balanceAfter": "integer",
    "referenceType": "string",
    "referenceId": "string",
    "createdAt": "string"
  },
  "balance": "integer",
  "currency": "string",
  "idempotent": false
}
```

</details>

<details>
<summary><code>200 OK</code> · Idempotent replay</summary>

Same shape as `201`, with `idempotent: true`.

</details>

<details>
<summary><code>400 Bad Request</code> · Validation error</summary>

```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "string" } }
```

</details>

<details>
<summary><code>404 Not Found</code> · Wallet doesn't exist</summary>

```jsonc
{ "error": { "code": "NOT_FOUND", "message": "string" } }
```

</details>

<details>
<summary><code>422 Unprocessable Entity</code> · Insufficient balance, currency mismatch, or amount overflow</summary>

```jsonc
{
  "error": {
    "code": "INSUFFICIENT_BALANCE | CURRENCY_MISMATCH | AMOUNT_OUT_OF_RANGE",
    "message": "string"
  }
}
```

</details>

**Sample cURL**

```bash
curl -X POST http://localhost:8080/wallets/<wallet-id>/deduct \
  -H 'content-type: application/json' \
  -d '{
    "amount": 10000,
    "currency": "USD",
    "referenceType": "ORDER_SYSTEM",
    "referenceId": "order-abc-123"
  }'
```

</details>

<details>
<summary><b>GET /wallets/:id/balance</b> · Current balance</summary>

<br/>

**Responses**

<details>
<summary><code>200 OK</code> · Balance returned</summary>

```jsonc
{
  "walletId": "string",      // UUID
  "balance": "integer",      // minor units of the currency
  "currency": "string"
}
```

</details>

<details>
<summary><code>400 Bad Request</code> · Non-UUID path id</summary>

```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "string" } }
```

</details>

<details>
<summary><code>404 Not Found</code> · Wallet doesn't exist</summary>

```jsonc
{ "error": { "code": "NOT_FOUND", "message": "string" } }
```

</details>

**Sample cURL**

```bash
curl http://localhost:8080/wallets/<wallet-id>/balance
```

</details>

<details>
<summary><b>GET /wallets/:id/transactions</b> · Ledger (cursor-paginated, newest first)</summary>

<br/>

**Query parameters**

```jsonc
{
  "limit": "integer",        // optional, 1 to 500, default 100
  "cursor": "string"         // optional, the id of the last entry from the previous page
}
```

**Responses**

<details>
<summary><code>200 OK</code> · Page returned</summary>

```jsonc
{
  "walletId": "string",
  "entries": [
    {
      "id": "string",
      "walletId": "string",
      "entryType": "string",     // CREDIT or DEBIT
      "amount": "integer",
      "balanceAfter": "integer",
      "referenceType": "string",
      "referenceId": "string",
      "createdAt": "string"
    }
  ],
  "nextCursor": "string",        // or null, feed back as cursor for the next page
  "hasMore": "boolean"
}
```

</details>

<details>
<summary><code>400 Bad Request</code> · Invalid cursor or non-UUID path id</summary>

```jsonc
{ "error": { "code": "VALIDATION_ERROR", "message": "string" } }
```

</details>

<details>
<summary><code>404 Not Found</code> · Wallet doesn't exist</summary>

```jsonc
{ "error": { "code": "NOT_FOUND", "message": "string" } }
```

</details>

**Sample cURL**

```bash
curl "http://localhost:8080/wallets/<wallet-id>/transactions?limit=50"
```

</details>

### 🤖 Order Service stub

A small script that pretends to be the upstream Order Service. Demonstrates idempotency by retrying the same `order_id` and confirming the wallet does not get double-charged. This was required as a deliverable by the original spec.

```bash
npx tsx order-service-stub/place-order.ts <wallet-id> --retry
```

---

## 🎯 5. System Design

The interesting engineering choices and the reasoning behind each.

### 🧰 Tech stack

| Tool | Role |
| :--- | :--- |
| **Node 20** | JavaScript runtime |
| **TypeScript** | Type-safe app code |
| **Fastify** | HTTP framework with first-class JSON-schema validation |
| **Postgres 16** | Database; source of truth for balances and the ledger |
| **Kysely** | Type-safe SQL query builder (not an ORM); compiles to plain SQL |
| **Ajv + ajv-formats** | JSON-schema validator; adds UUID, date-time, and other formats |
| **Pino** | Structured JSON logging, bundled with Fastify |
| **@fastify/swagger** | Auto-generates the OpenAPI 3.1 spec from route schemas |
| **Vitest** | Test framework |
| **ESLint + Prettier** | Static analysis + opinionated formatting |
| **Docker Compose** | One-command local dev (Postgres + service together) |
| **GitHub Actions** | CI: typecheck, lint, format, tests on every push and PR |

### 🗄 Table schema

Two tables. The ledger is the audit trail; the wallet's `balance` column is a running total kept honest by transactional atomicity.

```
┌────────────────────────────┐         ┌────────────────────────────────────┐
│ wallets                    │         │ wallet_ledger_entries              │
│ ────────────────────────── │         │ ────────────────────────────────── │
│ id                  UUID   │◀────────│ wallet_id            UUID          │
│ customer_id  UNIQUE        │         │ id                   UUID          │
│ currency            CHAR(3)│         │ entry_type           CREDIT/DEBIT  │
│ balance             BIGINT │         │ amount               BIGINT > 0    │
│ created_at, updated_at     │         │ balance_after        BIGINT        │
│                            │         │ reference_type       VARCHAR(32)   │
│ CHECK balance ≥ 0          │         │ reference_id         VARCHAR(128)  │
│ CHECK currency known       │         │ created_at           TIMESTAMPTZ   │
└────────────────────────────┘         │                                    │
                                       │ UNIQUE(wallet_id,                  │
                                       │        reference_type,             │
                                       │        reference_id)               │
                                       │ CHECK amount > 0                   │
                                       │ CHECK balance_after ≥ 0            │
                                       └────────────────────────────────────┘
```

> 🔑 The wallet update and the ledger insert always happen inside the **same DB transaction**. They commit together or roll back together, so the balance can never drift from the ledger.

### 💰 Maintaining current balance: three approaches

There are three honest ways to answer "what is this wallet's balance right now?"

<details open>
<summary><b>A. Recompute from the ledger every time</b> · ❌ rejected</summary>

`SUM(credits) - SUM(debits)` whenever someone asks.

| | Reads | Writes |
| --- | --- | --- |
| Cost | O(n) per request | O(n), since every debit needs the balance to check sufficiency |
| Cacheable? | ✅ on reads | ❌ on writes (a stale balance during a debit allows double-spending) |

The write path is the killer. Caching hides the read cost but cannot hide the write cost. An active wallet doing thousands of orders a day would buckle under its own success.

</details>

<details open>
<summary><b>B. Cached <code>balance</code> column, updated with every entry</b> · ✅ chosen</summary>

Every ledger insert is paired with `UPDATE wallets SET balance = balance + signed`, inside the same transaction.

| | Reads | Writes |
| --- | --- | --- |
| Cost | O(1) primary-key lookup | O(1): one update + one insert |
| Drift risk | Impossible: same transaction makes the two writes atomic |

This is what production financial systems use (Stripe, Razorpay, banks). A chaos test asserts `SUM(signed amounts) == wallets.balance` after thousands of operations.

</details>

<details>
<summary><b>C. Hybrid: derive balance from the latest ledger entry's <code>balance_after</code></b> · ❌ rejected</summary>

Drop the `balance` column; read `balance_after` from `ORDER BY created_at DESC LIMIT 1`. O(1) with the existing index.

Slightly purer, but a wallet that grows additional fields (status, tier, frozen-until) loses its natural home, and "show me all wallets with balance over $X" stops being a simple index scan.

</details>

### 💱 Handling currency and decimals

**One currency per wallet, today.** Every wallet is created in exactly one currency and only accepts operations in that same currency. Every mutation request must include a `currency` field; if it does not match the wallet's currency, the request is rejected with `422 CURRENCY_MISMATCH` before any state changes.

**Extensible to multi-currency tomorrow.** The schema already separates currency from amount. The natural next step is cross-currency operations via a real-time FX provider (Wise, Currencylayer, Open Exchange Rates). A USD wallet receiving a EUR topup would convert at a locked-in rate and record both the original amount and the rate on the ledger entry.

**Decimals: integer minor units.** Every amount in the API is an integer in the smallest unit of the currency (cents for USD/EUR/GBP/CAD, paise for INR). This is the convention every major fintech API uses (Stripe, Razorpay, Adyen, Square, AWS Payments).

Why integer minor units?

- Integer math is exact. Floats accumulate rounding errors (`0.1 + 0.2 !== 0.3` in IEEE 754).
- JSON numbers carry numbers safely up to 2⁵³; staying as integers avoids precision loss in transit.
- The ISO 4217 standard defines the minor unit per currency (0 decimals for JPY, 2 for USD, 3 for BHD). Clients are expected to know their currency's decimal count.

### 💯 Handling amount overflow

Two real limits live in the stack. Both are technical, not business.

| Layer | Limit | What happens when exceeded | Response |
| :--- | :--- | :--- | :--- |
| **API edge** (JSON schema) | `amount` ≤ `Number.MAX_SAFE_INTEGER` (2⁵³ − 1) | Above this, `JSON.parse` silently rounds | `400 VALIDATION_ERROR` |
| **Database** (BIGINT) | `balance + amount` ≤ 2⁶³ − 1 | Postgres raises SQLSTATE `22003` | `422 AMOUNT_OUT_OF_RANGE` |

The transaction rolls back on the DB error, so the wallet is unchanged.

### 🆔 Preventing duplicate wallets

A `UNIQUE (customer_id)` constraint on the `wallets` table. The constraint lives in the database, not the application. Two concurrent `POST /wallets` requests with the same `customerId` cannot both succeed: one wins, the other gets a unique-key violation that the error handler maps to `409 CONFLICT`. No application-level coordination needed.

### 🔁 Ensuring idempotency: the right scope

What should the dedupe key for "I have already processed this instruction" actually be?

| Scope | Behaviour | Verdict |
| :--- | :--- | :--- |
| `referenceId` alone | A retry of order `abc` and a refund of order `abc` get confused as the same operation | ❌ Loses information |
| `(referenceType, referenceId)` | Different upstream systems with overlapping IDs do not collide. But a campaign credit named `diwali-2025-cashback` going to 50,000 wallets would all return the first wallet's entry | ❌ Cross-wallet bug |
| **`(walletId, referenceType, referenceId)`** | Each wallet has its own dedupe space. Same campaign id across many wallets credits each wallet exactly once | ✅ Correct |

> 🔑 Adding `walletId` to the scope is what unlocks legitimate **mass-update flows** (cashback campaigns, subscription billing, disaster-relief credits). Without it, those flows silently drop 99% of the operations.

### 🔒 Locking: pessimistic vs optimistic

Two `/deduct` requests for $100 arrive at the same millisecond on a wallet that has $100. Only one must succeed.

<details open>
<summary><b>🐢 Pessimistic locking</b></summary>

Take a row-level lock first (`SELECT ... FOR UPDATE`), then check the balance, then mutate. Concurrent requests wait their turn.

- ✅ Simple to reason about. Easy to add more checks (status, tier, limits).
- ❌ Every request pays the lock cost, even on quiet wallets where contention is zero.

</details>

<details open>
<summary><b>🐰 Optimistic locking · ✅ chosen</b></summary>

Atomic conditional update: `UPDATE wallets SET balance = balance + signed WHERE id = ? AND balance + signed >= 0 RETURNING balance`. Insufficient balance returns zero rows; we react to that. If a concurrent request beats us to the ledger insert, the `UNIQUE` constraint fires; we roll back and recover the winner.

- ✅ Saves one query per request on the common path.
- ❌ The rare contention case costs one extra rollback.

</details>

> 🎯 For customer wallets (one person, occasional orders) contention is near zero. Optimistic wins on the average path by a wide margin.

### 🐘 Why Postgres, not MySQL

Three Postgres features make the optimistic pattern clean to write:

| Feature | Why we use it |
| :--- | :--- |
| `UPDATE ... RETURNING` | Get the new balance in the same statement as the mutation. MySQL needs a separate `SELECT` afterwards. |
| `INSERT ... ON CONFLICT DO NOTHING` | Race-safe ledger insert without try/catch on SQLSTATE codes. |
| Conditional UPDATE in one round-trip | Check-and-mutate as one atomic statement; no separate lock acquisition step. |

MySQL would work too, but every operation would need an extra round-trip. Postgres is faster on the happy path and easier to read.

### 📄 Pagination: cursor, not offset

`GET /wallets/:id/transactions` is cursor-paginated. The cursor is the `id` of the last entry from the previous page; the next query fetches entries strictly older than that anchor.

| Approach | Why we did not use it |
| :--- | :--- |
| `?page=N` | Append-only ledgers shift the window when new entries land. Same page returns different rows on consecutive calls. |
| `?offset=N` | `OFFSET 100000` makes Postgres scan and discard 100k rows. Slow as the ledger grows. |
| **`?cursor=<entry-id>`** ✅ | Anchored to row identity. Stable under concurrent writes. Uses the existing `(wallet_id, created_at DESC)` index. |

---

## 🧪 6. How we test it

Tests run against a real Postgres instance, not a mock, because the questions this service has to answer (does the row lock work? does the unique constraint catch races?) are precisely what a mock would lie about.

> 📊 **50 tests across 13 categories.** All green in CI on every push.

| Category | What it asserts |
| :--- | :--- |
| 🟢 Happy path | Create, credit, debit, balance/ledger reflects every op (INR and USD) |
| 💵 Balance constraint | Debit rejected on empty / insufficient wallet; exact-balance debit succeeds |
| 🔁 Idempotency | Same reference returns same entry; replay balance matches original |
| 🔬 Cross-system isolation | Same `reference_id` under different `reference_type` is treated as distinct |
| 💱 Currency safety | Mismatched currency rejected with 422 on both topup and deduct |
| ⏱ `updated_at` freshness | Wallet's `updated_at` advances whenever its balance changes |
| ⚡ Concurrent debits | 10 parallel debits on a 3-debit wallet: exactly 3 succeed, 7 fail |
| ⚡ Concurrent retries | 10 parallel same-reference requests: exactly 1 ledger entry |
| 🌪 Chaos invariant | 50-op chaos run: `SUM(signed) == balance` always holds |
| 🛂 Strict input validation | Negatives, zeros, floats, strings, null all rejected with 400 |
| 💯 Amount overflow | Accepts `MAX_SAFE_INTEGER`; rejects above; cumulative overflow returns 422 |
| 📄 Pagination | Iterates 12 entries at limit=5, stable order, no duplicates |
| 🩺 Health + 📚 OpenAPI | Live, ready (with DB check), and `/docs/json` all respond correctly |

```bash
docker compose up -d postgres   # start the DB
npm test                        # run the suite (50 tests, ~1 second)
npm run typecheck               # strict tsc
npm run lint                    # ESLint with TypeScript + Prettier configs
npm run format                  # prettier --write
```

CI runs all of these on every push and pull request.

---

## 📂 7. Project Layout

```
.
├── docker-compose.yml             # Postgres + service in one command
├── Dockerfile                     # multi-stage service image
├── migrations/
│   └── 001_init.sql               # schema, applied on first DB boot
├── order-service-stub/
│   └── place-order.ts             # upstream caller, with retry simulation
├── src/
│   ├── server.ts                  # entrypoint, graceful shutdown
│   ├── app.ts                     # Fastify wiring, strict Ajv, OpenAPI, error mapping
│   ├── config.ts                  # env vars
│   ├── db/
│   │   ├── index.ts               # Kysely + pg pool
│   │   ├── schema.ts              # row types
│   │   └── migrate.ts             # CLI: run SQL files in order
│   ├── routes/
│   │   └── wallets.ts             # HTTP handlers + JSON-schema validation
│   ├── services/
│   │   └── wallet-service.ts      # the heart: optimistic concurrency + idempotency
│   └── errors.ts                  # typed errors to status codes
├── tests/
│   ├── setup.ts                   # shared Fastify + DB lifecycle
│   └── wallet.test.ts             # 50 tests across 13 categories
└── .github/workflows/ci.yml       # GitHub Actions: typecheck, lint, format, test
```

<br/>

<div align="center">

<sub>Emphasis on engineering judgment, not line count.</sub>

</div>
