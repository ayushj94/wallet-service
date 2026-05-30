<div align="center">

# 💰 Prepaid Wallet Service

**A small, careful service that holds customer money — and never loses a paise of it.**

<sub>Node 20 · TypeScript · Fastify · Postgres 16 · Kysely · Vitest</sub>

<br/>

<sub>

[![CI](https://github.com/ayushj94/wallet-service/actions/workflows/ci.yml/badge.svg)](https://github.com/ayushj94/wallet-service/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-20-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/typescript-5.5-3178C6?logo=typescript&logoColor=white)
![Postgres](https://img.shields.io/badge/postgres-16-336791?logo=postgresql&logoColor=white)
![Fastify](https://img.shields.io/badge/fastify-4-000000?logo=fastify&logoColor=white)
![Tests](https://img.shields.io/badge/tests-51_passing-brightgreen)

</sub>

</div>

<br/>

> 🎯 **Two unbreakable rules.**
> A wallet must never go negative.
> A retried request must never charge twice.
>
> Everything in this repo is built around honouring those two rules — under load, under retries, under concurrent activity on the same wallet.

---

## 📑 Table of contents

<table>
<tr>
<td valign="top">

**Getting started**

- [What this is](#-what-this-is)
- [Run it](#%EF%B8%8F-run-it)
- [Try it out](#-try-it-out)
- [API at a glance](#-api-at-a-glance)
- [Data model](#%EF%B8%8F-how-the-data-is-shaped)

</td>
<td valign="top">

**Engineering depth**

- [Two big design decisions](#-the-two-big-design-decisions)
- [Idempotency, in depth](#-idempotency-in-depth)
- [Currency, in depth](#-currency-in-depth)
- [Strict input validation](#-strict-input-validation)

</td>
<td valign="top">

**Quality & next steps**

- [How we test it](#-how-we-test-it)
- [What I'd do with more time](#-what-id-do-with-more-time)
- [Project layout](#-project-layout)

</td>
</tr>
</table>

---

## 📋 What this is

A logistics platform's customers prepay money into a wallet. Every order debits a fixed amount; topups credit it. The wallet service is the source of truth for **every paise** that moves — it owns the balances, records every movement to an append-only ledger, and enforces the never-negative rule under any timing.

---

## ▶️ Run it

```bash
docker compose up --build
```

That brings up Postgres, applies the schema on first boot, and starts the service on **[localhost:8080](http://localhost:8080)**.

Health check + interactive API docs:

```bash
curl localhost:8080/health           # liveness
open http://localhost:8080/docs      # OpenAPI 3.1 spec & try-it-out UI
```

<details>
<summary><b>🛠 Run without Docker</b> — point at your own Postgres</summary>

```bash
cp .env.example .env       # point at your Postgres
npm install
npm run migrate            # applies migrations/001_init.sql
npm run dev
```

</details>

---

## 🚀 Try it out

<table>
<tr>
<td>

```bash
# Create an INR wallet for a customer
WALLET=$(curl -s -X POST localhost:8080/wallets \
  -H 'content-type: application/json' \
  -d '{"customerId":"acme-corp","currency":"INR"}' \
  | jq -r .id)

# Top up ₹500 (50000 paise)
curl -s -X POST localhost:8080/wallets/$WALLET/topup \
  -H 'content-type: application/json' \
  -d '{
    "amount": 50000,
    "currency": "INR",
    "referenceType": "PAYMENT_SYSTEM",
    "referenceId": "payment-001"
  }'
```

</td>
<td>

```bash
# Place an order — deduct ₹100
curl -s -X POST localhost:8080/wallets/$WALLET/deduct \
  -H 'content-type: application/json' \
  -d '{
    "amount": 10000,
    "currency": "INR",
    "referenceType": "ORDER_SYSTEM",
    "referenceId": "order-abc-123"
  }'

# Retry the same order — same response, no double-charge
curl -s -X POST localhost:8080/wallets/$WALLET/deduct \
  -H 'content-type: application/json' \
  -d '{
    "amount": 10000,
    "currency": "INR",
    "referenceType": "ORDER_SYSTEM",
    "referenceId": "order-abc-123"
  }'

# Balance and ledger
curl -s localhost:8080/wallets/$WALLET/balance
curl -s localhost:8080/wallets/$WALLET/transactions
```

</td>
</tr>
</table>

### 🤖 Order Service stub

A script that pretends to be the upstream Order Service. Demonstrates idempotency by retrying the same `order_id` and confirming the wallet isn't double-charged:

```bash
npx tsx order-service-stub/place-order.ts <wallet-id> --retry
```

---

## 🔌 API at a glance

| Method | Path | What it does |
| :---: | --- | --- |
| `POST` | `/wallets` | Open a wallet for a customer in a chosen currency |
| `POST` | `/wallets/:id/topup` | Add money (idempotent) |
| `POST` | `/wallets/:id/deduct` | Take money for an order (idempotent) |
| `GET`  | `/wallets/:id/balance` | Current balance + currency |
| `GET`  | `/wallets/:id/transactions` | The ledger — every credit and debit (cursor-paginated) |
| `GET`  | `/health/live` | Liveness — is the process up? |
| `GET`  | `/health/ready` | Readiness — is the DB reachable? |
| `GET`  | `/docs` | Interactive OpenAPI 3.1 spec (auto-generated from JSON schemas) |

### 💱 Amount conventions

> 🔑 **All amounts are integers in the smallest unit of the wallet's currency.**
> Paise for INR, cents for USD/EUR/GBP/CAD. `amount: 50000` means **₹500 on an INR wallet**, **$500 on a USD wallet**, and so on.

This matches the convention every major fintech API uses (Stripe, Razorpay, Adyen). See [Currency, in depth](#-currency-in-depth) for the rationale.

### 📄 Pagination on `/transactions`

The ledger is cursor-paginated, not offset-paginated — append-only logs are exactly the case where offsets get unreliable (new entries shift the window) and slow (`OFFSET 100000` scans).

```
GET /wallets/:id/transactions?limit=100&cursor=<entry-id>
```

| Field | Description |
| --- | --- |
| `limit` | Page size, 1–500. Default 100. |
| `cursor` | The `id` of the last entry from the previous page. Omit for the first page. |

The response shape:

```json
{
  "walletId": "...",
  "entries": [ ... ],
  "nextCursor": "uuid" | null,
  "hasMore": true | false
}
```

Iterate by feeding `nextCursor` back as `cursor` on the next call until `hasMore: false`. Cursors are stable under concurrent writes — they anchor to a specific row, not a position.

### 🔁 Idempotency

Every mutation request supplies:

- **`referenceType`** — the upstream system originating the instruction (`ORDER_SYSTEM`, `PAYMENT_SYSTEM`, `LOAN_SYSTEM`, …)
- **`referenceId`** — the specific instruction ID generated by that source system

A retry with the same `(referenceType, referenceId)` on the same wallet returns the existing entry instead of running the operation again. The response's `balance` reflects the balance **immediately after the original operation** (true Stripe-style idempotent replay), not the current balance — so retries are byte-identical to the original response. See [Idempotency, in depth](#-idempotency-in-depth) for why the design works this way.

<details>
<summary><b>Response codes</b></summary>

| Code | When |
| :---: | --- |
| `201` | Resource created — wallet or new ledger entry |
| `200` | Idempotent replay — returns the existing entry |
| `400` | Malformed request (missing field, non-positive amount, wrong type, …) |
| `404` | Wallet doesn't exist |
| `422` | Insufficient balance, or `CURRENCY_MISMATCH` |
| `409` | Idempotency conflict (backstop only — the service path catches this internally) |
| `503` | Readiness probe failed — DB unreachable |

</details>

---

## 🗄️ How the data is shaped

```
┌────────────────────────────┐         ┌────────────────────────────────────┐
│ wallets                    │         │ wallet_ledger_entries              │
│ ────────────────────────── │         │ ────────────────────────────────── │
│ id                  UUID   │◀────────│ wallet_id            UUID          │
│ customer_id         UNIQUE │         │ id                   UUID          │
│ currency            CHAR(3)│         │ entry_type           CREDIT/DEBIT  │
│ balance             BIGINT │         │ amount               BIGINT > 0    │
│ created_at, updated_at     │         │ balance_after        BIGINT        │
│                            │         │ reference_type       VARCHAR(32)   │
│ CHECK balance ≥ 0          │         │ reference_id         VARCHAR(128)  │
│ CHECK currency known       │         │ created_at           TIMESTAMPTZ   │
└────────────────────────────┘         │                                    │
                                       │ UNIQUE (wallet_id,                 │
                                       │         reference_type,            │
                                       │         reference_id)              │
                                       │ CHECK amount > 0                   │
                                       │ CHECK balance_after ≥ 0            │
                                       └────────────────────────────────────┘
```

A few choices worth pointing out:

<table>
<tr>
<td>

**💰 Money in integer minor units**

No floats anywhere. The currency lives on the wallet, so the same `BIGINT` column means *cents* in one wallet and *paise* in another. Display logic interprets per currency.

</td>
<td>

**📸 `balance_after` snapshot per entry**

Every ledger row stores the wallet balance immediately after that entry was applied. Auditing any historical moment is a single indexed lookup, not a SUM scan.

</td>
</tr>
<tr>
<td>

**➕ `amount` is always positive**

Direction lives in `entry_type`. Easier to read, easier to write reports — "show me all credits this month" is `WHERE entry_type = 'CREDIT'`.

</td>
<td>

**🔒 `UNIQUE (wallet_id, reference_type, reference_id)`**

The safety net that makes retries safe. Two requests with the same reference on the same wallet → second one returns the first's result, no double charge.

</td>
</tr>
</table>

---

## 🎯 The two big design decisions

This section is the heart of the README. Everything else is plumbing.

### 1️⃣ Where does the balance live?

We could have built this three ways. Each one is a real choice you'll see in different production systems.

<details open>
<summary><b>Option A — Compute the balance from the ledger every time</b></summary>

The ledger is already an append-only record of every credit and debit. So why store the balance separately at all? Just `SUM(credits) - SUM(debits)` whenever someone asks.

It's clean and elegant. There's only one source of truth, and it can never drift from itself.

The problem isn't the read path — it's the **write path**.

Every `/deduct` has to first answer: "is there enough money?" That means computing the current balance *before* the mutation. So the deduct path *also* has to scan the entire ledger — every single time, for every order.

You can't cache your way out of this. The deduct needs the **authoritative, up-to-the-microsecond** balance to make a correctness decision. A stale cache could let two orders both pass a balance check that's actually only good for one — and you've double-spent.

| | Reads | Writes |
| --- | --- | --- |
| Cost | Slow (O of total entries) | **Slow (same scan)** |
| Cacheable? | ✅ Yes — fast after warmup | ❌ **No** — cache can't be trusted for correctness |

> ⚠️ **Caching hides the read problem but does nothing for the write problem.** For an active wallet that does a thousand orders a day, this design buckles under its own success.

</details>

<details open>
<summary><b>Option B — Keep a <code>balance</code> column, updated with every entry ✅ <i>(chosen)</i></b></summary>

Every time we write a ledger entry, we update `wallets.balance` to match — in the same database transaction, so they can't get out of step.

| | Reads | Writes |
| --- | --- | --- |
| Cost | One indexed lookup | One indexed lookup + one update |
| Drift risk | Impossible — the transaction makes them atomic | Same |

`/balance` becomes a single primary-key read. The deduct path reads the current balance, checks it, writes the new value — all in one tightly-scoped transaction.

The only theoretical concern is drift between the column and the ledger. But because every change happens in the same transaction, drift would require a database bug, not a logic bug. The chaos test (`SUM(signed amounts) == wallets.balance`) is the canary — if anyone ever moves the wallet update outside the transaction, that test screams.

</details>

<details>
<summary><b>Option C — Hybrid: derive balance from the latest ledger entry's <code>balance_after</code></b></summary>

We already write `balance_after` to every ledger entry. So you could drop the `wallets.balance` column entirely and read `balance_after` from the most recent ledger entry for the wallet. O(1) with the existing `(wallet_id, created_at DESC)` index.

It works. It's slightly purer. But:

- A wallet that grows additional fields (status, tier, daily-limit, frozen-until) loses its natural home — those don't belong on a ledger entry.
- "Show me all wallets with balance over ₹10000" stops being a simple index scan.

So we stick with Option B: a real balance column, kept honest by atomic transactions.

</details>

---

### 2️⃣ How do we stop two requests from spending the same money?

> 💡 Imagine a wallet has ₹100, and two `/deduct` requests for ₹100 arrive at the exact same millisecond. Both read the balance (₹100), both decide they're allowed to proceed, both debit. The wallet now reads ₹-100 — a hole the business has to absorb.

This is the central correctness question. There are three honest ways to solve it.

<details open>
<summary><b>🐢 Pessimistic locking — "everyone wait your turn"</b></summary>

The first request to arrive takes a **row-level lock** on the wallet — telling the database "nobody else touches this row until I'm done." The second request has to wait. When the first commits, the second wakes up, sees the new balance, and either proceeds or fails.

```
Request A: lock → read balance → debit → commit → release
Request B:            wait...........................wait → lock → read → debit
```

- ✅ Simple to reason about. No retries, no rollbacks, no surprises.
- ✅ Easy to extend with additional checks (status, tier, limits) inside the locked section.
- ❌ Every request pays the lock cost, even when there's no contention. On a quiet wallet — which is most of them — that's a tax you didn't need to pay.

</details>

<details open>
<summary><b>🐰 Optimistic locking — "race ahead, undo if we collide" ✅ <i>(chosen)</i></b></summary>

Try to mutate without locking first. The mutation itself is atomic — Postgres lets you say "update the balance, but only if it would stay non-negative, and tell me the new value." If two requests race, **one wins, one comes back with `0 rows affected`** and knows it lost.

```
Request A:   try-debit (success) → write ledger → done
Request B:   try-debit (success) → write ledger → conflict! → roll back → look up A's result
```

- ✅ When there's no contention (which is most of the time for a customer wallet), this saves a query per request.
- ✅ Faster average-case throughput.
- ❌ When there *is* contention, the loser pays extra — it rolled back work it shouldn't have started.

</details>

<details>
<summary><b>🤔 Double-checked — "peek first, then lock if it looks promising"</b></summary>

A clever-sounding optimization: do a quick, lockless read of the balance first. If it's clearly insufficient, reject right away without bothering to take a lock. If it looks promising, take the lock and check properly.

```
Request: read balance (no lock) → not enough? reject
                                → enough?     lock → read again → debit
```

- ✅ Saves a lock for guaranteed-to-fail requests.
- ❌ The "expensive" lock isn't actually expensive — it's microseconds. The extra read costs a millisecond of network round trip. **You've added a guaranteed cost to make a rare case cheaper.**
- ❌ The lockless read can be stale, leading to false negatives if a topup commits in between the two reads.

</details>

#### 📊 Why optimistic wins for our workload

Customer wallets have very low contention (one person isn't firing a hundred concurrent orders on themselves). The happy-path win is worth more than the rare-case loss.

| | Happy path (no contention) | Race path (concurrent same reference) |
| --- | --- | --- |
| 🐢 Pessimistic | 4 queries | 4 + 2 queries (loser waits, returns the existing entry) |
| 🐰 **Optimistic (chosen)** | **3 queries** | 3 + 4 queries + 1 rollback |
| 🤔 Double-check | 4 + 1 queries | 4 + 2 + 1 queries |

> 🎯 The happy path runs **millions of times more often** than the conflict path. Optimistic wins overall, by a wide margin, for any real wallet workload.

On a busy B2B logistics wallet with many concurrent ops, the math gets closer — pessimistic has its case there. But you'd want *sharded balances* long before single-row contention became a real bottleneck.

---

## 🔐 Idempotency, in depth

### The mechanism

Two layers cooperate to make retries safe:

1. **🔎 Lookup first** — before any work, look up `(wallet_id, reference_type, reference_id)` in the ledger. If a row exists, we've already processed this instruction → return it. This handles almost every retry, because retries usually arrive *after* the original committed.

2. **🪤 The unique constraint** — `UNIQUE (wallet_id, reference_type, reference_id)` is the safety net for the rare case where two requests with the same reference are *truly* in flight at the same moment. Neither has committed yet, so both lookups see nothing and both proceed. The database rejects the second insert; our code rolls back its wallet update and fetches the entry that committed first.

### Why `wallet_id` is part of the dedup scope

This is non-obvious and worth dwelling on. The dedup scope isn't `(reference_type, reference_id)` — it's `(wallet_id, reference_type, reference_id)`.

<details open>
<summary><b>💡 Real example: bulk promotional credit</b></summary>

Promo Service runs "Diwali Cashback 2025" — every customer who shopped this week gets ₹100. It queries for 50,000 eligible customers and calls our API for each:

```
POST /wallets/customer-A-wallet/topup
  body: { referenceType: "PROMO_SYSTEM", referenceId: "diwali-2025-cashback", amount: 10000 }

POST /wallets/customer-B-wallet/topup
  body: { referenceType: "PROMO_SYSTEM", referenceId: "diwali-2025-cashback", amount: 10000 }

POST /wallets/customer-C-wallet/topup
  body: { referenceType: "PROMO_SYSTEM", referenceId: "diwali-2025-cashback", amount: 10000 }
...
```

From the Promo Service's perspective there's **one campaign**, identified by one ID. They naturally use it as the reference. Forcing them to invent `diwali-2025-cashback-{customer_id}` just to dodge our dedup logic is busywork.

**With wallet-scoped uniqueness (our design):** ✅ Each wallet gets its own ledger entry. If Promo Service retries the call for customer A specifically, A's entry is dedupe-protected. 50,000 separate entries, 50,000 separate dedupes.

**With tight scope (no `wallet_id`):** ❌ Customer A's wallet gets credited. All 49,999 subsequent calls look up `(PROMO_SYSTEM, diwali-2025-cashback)`, find A's entry, and silently return it as "already processed." 49,999 customers never get their cashback.

</details>

Other realistic scenarios for the same pattern:
- **Subscription billing**: charge every premium subscriber on the 1st of the month under one reference.
- **Disaster relief credits**: credit every customer in an affected region under one reference.
- **Migration from a per-customer system**: legacy ledgers where each customer has their own `txn-1, txn-2` sequence.

> 🔑 **The dedup unit that matters is "have I done this instruction *on this wallet*?"** — not "have I seen this instruction anywhere in the world?"

### Why we merged the idempotency key into `(reference_type, reference_id)`

The industry-standard pattern (Stripe et al.) keeps a separate `Idempotency-Key` header — purely a transport concern, decoupled from any business ID. We collapsed them: the source system's instruction ID *is* the dedup key, scoped per source system.

<details>
<summary><b>🆚 Trade-off comparison</b></summary>

| | Separate `idempotency_key` (Stripe) | Merged `(reference_type, reference_id)` (us) |
| --- | --- | --- |
| **API ergonomics** | Two fields to populate | One conceptual identifier |
| **Caller discipline** | Forgiving — bad business IDs only break that caller's retries | Strict — needs *one ID per instruction, reused on retry, never reused for different instruction* |
| **Multiple ops per business event** | Natural — different idempotency keys, same business ID | Awkward — need sub-IDs like `order-123-charge`, `order-123-tip` |
| **Right for** | Public API with many unknown callers | Internal service with well-known source systems |

For our scope — internal-only with disciplined callers — the merged design is fine. If we ever opened this externally, the right move would be to switch to a separate idempotency_key like Stripe.

</details>

<details>
<summary><b>🆚 How does this compare to Stripe?</b></summary>

Stripe's idempotency model looks like a single field but is actually **scoped by the API key** used to make the request. Their effective dedup identity is `(api_key, idempotency_key)`.

So both designs are three-axis:

| | Axis 1 (caller identity) | Axis 2 (caller's keyspace) | Axis 3 (operation) |
| --- | --- | --- | --- |
| 🟦 Stripe | API key | — | `idempotency_key` |
| 🟩 Us | `reference_type` | `wallet_id` | `reference_id` |

The big difference: Stripe's `api_key` is also an *auth credential*. Nobody can claim to be "Payment Gateway X" without possessing that key. Our `reference_type` is purely declarative — a malicious caller could lie. For an internal wallet behind a trusted network boundary, that's fine; the day we expose this externally, the right fix is to bind `reference_type` to authenticated identity (mTLS, JWT claim, API key, …).

</details>

### Why `/topup` is idempotent too

The spec only required `/deduct` to be idempotent. We extended it to `/topup` using the same mechanism. Real-world topups also retry — payment-gateway webhooks fire twice, customers refresh the checkout page, etc. Same code path, same guarantees.

> ⚠️ A double-credit is at least as bad as a double-debit — arguably worse, because it's free money the business has to absorb.

### Who generates the reference IDs?

The **caller** always does. The wallet service can't generate them, because:

- The caller is the one who knows whether two requests are the same logical operation.
- Two requests with identical bodies might be intentional duplicates (e.g., two separate orders for the same item).

How callers typically generate them:

- **UUIDv4 per logical instruction.** Generated once, persisted by the caller, reused on every retry attempt.
- **Deterministic hash** of business inputs — gives a stable ID without storing state.
- **Natural business ID** — `order-123`, `payment-456`, `loan-installment-789`. What most of our callers will use.

> ⚠️ **Common pitfall**: generating a new ID on each retry. Defeats the whole mechanism. SDKs solve this by storing the key on the request object across retries.

---

## 💱 Currency, in depth

### The minor-unit convention

Every amount in our API is an **integer in the smallest unit of the wallet's currency**:

- `amount: 50000` on an INR wallet = ₹500.00 (50000 paise)
- `amount: 50000` on a USD wallet = $500.00 (50000 cents)
- `amount: 50000` on a JPY wallet (if we supported it) would be ¥50000 (no fractional unit)

This is the convention every major fintech API uses. Stripe, Razorpay, Adyen, AWS Payments, Square — same pattern across the board.

> 🔑 Why? **Integer math is exact, JSON-safe, and avoids the silent precision loss that haunts floating-point numbers.** `0.1 + 0.2 !== 0.3` in IEEE 754 — and you don't want that in your financial system.

### ISO 4217 — the standard

The international standard that defines the currency-to-decimal mapping is **ISO 4217**. It defines:

- The 3-letter currency code (`USD`, `JPY`, `BHD`)
- The numeric code (`840`, `392`, `048`)
- **The number of decimal places** (the "exponent" or "minor unit")

<details open>
<summary><b>📊 The full precision hierarchy in fiat</b></summary>

| Decimals | Currencies | Example |
| :---: | --- | --- |
| **0** | `JPY`, `KRW`, `VND`, `ISK`, `CLP`, `RWF`, `UGX`, `XAF`, `XOF`, `XPF` (~10 total) | `1000` = ¥1000 |
| **2** | `USD`, `EUR`, `GBP`, `CAD`, `INR`, `AUD`, `CNY`, `BRL`, `MXN`, … (**~150 currencies**, the vast majority) | `1000` = $10.00 |
| **3** | `BHD` (Bahrain), `KWD` (Kuwait), `JOD` (Jordan), `OMR` (Oman), `TND` (Tunisia), `LYD` (Libya) | `1000` = 1.000 BHD |
| **4** | `CLF` (Chilean inflation-indexed unit), `UYW` (Uruguayan) — rare, special-purpose | `10000` = 1.0000 CLF |

</details>

So the same integer means wildly different things across currencies:
- `100` = $1.00 in USD
- `100` = ¥100 in JPY
- `100` = 0.100 BHD in Bahrain

### Why this gets misapplied — even by professionals

> ⚠️ ISO 4217 is famously well-known **in theory** and constantly misapplied **in practice.**

<details>
<summary><b>🪲 Common real-world bugs</b></summary>

- **Hardcoded `× 100`** — assumes 2-decimal universally. Silently 100× overcharges JPY customers and 10× undercharges BHD ones.
- **Float arithmetic for amounts** — `0.1 + 0.2 !== 0.3`. Sums of `$0.30` become `$0.30000000000000004` after enough additions.
- **Decimal string parsing without locale awareness** — `"1,000.50"` (US format) vs `"1.000,50"` (European format). Same number, different parsing, no error.
- **Inconsistent precision in storage** — DB column is `NUMERIC(20,4)` but the app truncates to 2 places before insert.

</details>

### How big fintech mitigates this

<table>
<tr>
<td><b>📖 Documentation per currency</b></td>
<td>Stripe has a full page listing every currency with its minor unit and conventions. First-class part of the API reference.</td>
</tr>
<tr>
<td><b>📦 SDK helpers</b></td>
<td>Official client libraries provide <code>Money.fromDecimal("10.50", "USD")</code> → <code>1050</code>. Pushes conversion into shared, tested code instead of every client reinventing it.</td>
</tr>
<tr>
<td><b>🚧 Per-currency maximums</b></td>
<td>Reject amounts above a sensible ceiling (e.g., $999,999.99 USD). Catches a lot of precision-shifted bugs because "100× too big" amounts usually trip the ceiling.</td>
</tr>
<tr>
<td><b>🚫 Float-free APIs</b></td>
<td>Modern APIs accept integers only. Our JSON-schema validation does the same — see <a href="#-strict-input-validation">strict input validation</a>.</td>
</tr>
</table>

### Single-currency wallets today

Each wallet is created in exactly one currency and only accepts operations in
that same currency. Every mutation request **must** include a `currency` field;
if it doesn't match the wallet's currency, the request is rejected with
`422 CURRENCY_MISMATCH` before any state changes.

> 🔑 **No implicit defaults anywhere.** Financial systems are too critical for "I
> assume this is INR" to ever be true on the server side. `currency` is required
> at wallet creation, on every topup, and on every deduct.

This is a deliberate constraint, not a limitation of the underlying design — it
makes the simple case provably safe.

### What we'd add at scale

| | |
| --- | --- |
| 💱 **Cross-currency operations via FX conversion** | A USD wallet receiving a EUR topup would call a real-time FX provider (e.g. Wise, Currencylayer, Open Exchange Rates), convert at the locked-in rate, record the conversion as part of the ledger entry's metadata (`original_amount`, `original_currency`, `fx_rate`, `fx_provider`), and complete the operation in the wallet's native currency. The ledger preserves auditability of the original amount and the rate used. |
| 🛡 **Per-currency maximums** as a sanity net | Reject amounts above a sensible ceiling per currency. Catches precision-shifted bugs (a "100× too big" amount usually trips the ceiling). This is the Stripe technique. |
| 📦 **Shared `Money` library** | A common helper exposed to all callers so the decimal↔minor-unit conversion isn't reimplemented per team. `Money.fromDecimal("10.50", "USD")` → `1050`. |
| 📖 **Explicit OpenAPI documentation** | Per-currency decimal places with worked examples. Generated from the JSON schemas. |

---

## ✅ Strict input validation

Every mutation request goes through Fastify's JSON-schema validation **before the route handler runs**. Anything malformed gets `400` and never touches the database.

> 🔒 The request **body** uses a strict Ajv (`coerceTypes: false`). Accepting `"100"` for `amount` and silently converting to `100` is a footgun for financial APIs. **Query strings and route params** use a lenient Ajv (the standard `coerceTypes: 'array'`) because HTTP query strings are always strings on the wire — `?limit=5` has to be coerced to a number or the schema can never accept it.

### 💯 Amount range — the technical limit

`amount` is capped at `Number.MAX_SAFE_INTEGER` (2⁵³ − 1 ≈ 9 quadrillion) in the JSON schema. This isn't a business rule — it's the largest integer JavaScript can represent without precision loss. Above this, `JSON.parse` silently rounds, which would corrupt amounts mid-flight. We reject before that can happen.

For the very-long-tail case where a wallet's `balance + amount` would exceed Postgres' `BIGINT` (2⁶³ − 1), Postgres raises SQLSTATE `22003`. The error handler catches it and returns `422 AMOUNT_OUT_OF_RANGE`. The transaction rolls back, so the wallet balance is unaffected.

### What gets rejected, and why

<table>
<tr>
<th>Input</th>
<th>Why it's rejected</th>
<th>Example payloads</th>
</tr>
<tr>
<td>❌ Negative integer</td>
<td><code>minimum: 1</code></td>
<td><code>amount: -1</code>, <code>amount: -100</code></td>
</tr>
<tr>
<td>❌ Zero</td>
<td><code>minimum: 1</code></td>
<td><code>amount: 0</code></td>
</tr>
<tr>
<td>❌ Float</td>
<td><code>type: integer</code></td>
<td><code>amount: 1.5</code>, <code>amount: -1.5</code>, <code>amount: 100.5</code></td>
</tr>
<tr>
<td>❌ String</td>
<td><code>type: integer</code> + coercion off</td>
<td><code>amount: "100"</code></td>
</tr>
<tr>
<td>❌ Null</td>
<td><code>type: integer</code></td>
<td><code>amount: null</code></td>
</tr>
</table>

> 🧪 17 dedicated tests run the matrix above against both `/topup` and `/deduct`, and a separate test fires three different malformed requests and asserts **zero** new rows in `wallet_ledger_entries` — proving the database is never touched.

---

## 🧪 How we test it

The test suite runs against a **real Postgres instance**, not a mock — because the questions this service has to answer (does the row lock work? does the unique constraint catch races?) are precisely what a mock would lie about.

<details open>
<summary><b>📋 51 tests across 13 categories</b></summary>

| Category | What it asserts |
| --- | --- |
| 🟢 Happy path | Create → credit → debit → balance/ledger reflects every operation |
| 💵 Balance constraint | Debit rejected on empty / insufficient wallet; exact-balance debit succeeds |
| 🔁 Idempotency (debit) | Same reference returns same entry; replay balance matches original |
| 🔁 Idempotency (credit) | Same — beyond what the spec required |
| 🔬 Cross-system isolation | Same `reference_id` under different `reference_type` is treated as distinct |
| 💱 Currency safety | Mismatched currency rejected with 422 on both topup and deduct |
| ⏱ `updated_at` freshness | Wallet's `updated_at` advances whenever its balance changes |
| ⚡ **Concurrent debits** | 10 parallel requests on a ₹300 wallet → exactly 3 succeed, 7 fail with 422 |
| ⚡ **Concurrent retries** | 10 parallel requests with the same reference → exactly 1 ledger entry |
| 🌪 **Chaos invariant** | 50-op chaos run → `SUM(signed amounts) == wallets.balance` afterwards |
| 🛂 Strict input validation | 16 cases × 2 endpoints — negatives, zeros, floats, strings, null all rejected with 400 |
| 🚧 DB untouched on rejection | Bad requests never insert ledger rows |
| ❓ Not found | Unknown wallet → 404 on all paths |
| 📄 Pagination | Iterates through 12 entries at limit=5 — order stable, no duplicates, terminates |
| 📄 Pagination cursor invalid | Invalid cursor → 400 |
| 🩺 Health endpoints | `/health/live`, `/health/ready` (with DB check), `/health` legacy alias |
| 💯 Amount range | Accepts `MAX_SAFE_INTEGER`; rejects above; cumulative overflow → 422 |
| 📚 OpenAPI docs | `/docs/json` exposes OpenAPI 3.1 spec with every documented route |
| 🆔 UUID path validation | Non-UUID path params → 400 (no DB round-trip) |

</details>

```bash
docker compose up -d postgres   # start the DB
npm test                        # run the suite (51 tests)
npm run typecheck               # strict tsc
npm run lint                    # ESLint with TypeScript + Prettier configs
npm run format                  # prettier --write
```

CI runs all of these on every push and pull request — see `.github/workflows/ci.yml`.

> 🌪 The **chaos test** is the most valuable one. If `SUM(ledger) == balance` ever fails, it means the atomicity between the ledger insert and the wallet update has broken — that's a canary worth keeping forever.

---

## 🚀 What I'd do with more time

<table>
<tr>
<td valign="top">

**🛡 Defenses**

- Per-wallet rate limiting (Redis)
- Per-currency amount maximums
- Reconciliation job — hourly assert `SUM(ledger) == balance` across all wallets
- Reference ID expiry (TTL after 24h)

</td>
<td valign="top">

**📈 Scale**

- Read replica for balance lookups
- Sharded balances for hot wallets
- Optimistic balance caching with invalidation
- OpenTelemetry tracing

</td>
<td valign="top">

**🧩 Features**

- **Cross-currency operations** via real-time FX conversion (e.g. USD wallet, EUR topup → fetch rate, convert, record both original and converted amounts on the ledger)
- More entry types — `REFUND`, `ADJUSTMENT`, `BONUS_CREDIT`
- Settlement states — `PENDING` → `COMPLETED`
- Multiple wallets per customer (different currencies for the same person)
- Shared `Money` helper library for callers

</td>
</tr>
</table>

---

## 📂 Project layout

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
│   ├── app.ts                     # Fastify wiring, strict Ajv, error → HTTP mapping
│   ├── config.ts                  # env vars
│   ├── db/
│   │   ├── index.ts               # Kysely + pg pool
│   │   ├── schema.ts              # row types
│   │   └── migrate.ts             # CLI: run SQL files in order
│   ├── routes/
│   │   └── wallets.ts             # HTTP handlers + JSON-schema validation
│   ├── services/
│   │   └── wallet-service.ts      # the heart — optimistic concurrency + idempotency
│   └── errors.ts                  # typed errors → status codes
└── tests/
    ├── setup.ts                   # shared Fastify + DB lifecycle
    └── wallet.test.ts             # 34 tests: happy, balance, idempotency, currency, concurrency, chaos
```

<br/>

<div align="center">

<sub>Emphasis on engineering judgment, not line count.</sub>

</div>
