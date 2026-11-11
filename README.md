# Reliable Workflow Engine / Distributed Task Orchestrator

A fault-tolerant backend system designed to execute multi-step, long-running processes reliably — ensuring state persistence, graceful recovery from server crashes, and consistent execution.

Built for the _Software Verification_ subject as a working TypeScript reference implementation.

> **Status:** working vertical slice. Durable engine, crash recovery, retries, saga compensation, REST API, demo order workflow, and an automated test suite are implemented.

---

## 💡 Problem & Purpose

In backend systems, many business processes consist of multiple dependent tasks that must execute reliably, often spanning extended periods.

Consider a standard **Order-Processing Workflow**:

1. **Reserve Inventory**
2. **Process Payment**
3. **Arrange Shipping**

If a server crashes or an external service fails midway through this sequence, a basic implementation risks losing state, double-charging customers, or failing to fulfill orders.

This project provides a robust orchestration layer that guarantees:

- **Durability:** every state transition is recorded before moving forward.
- **Fault Tolerance & Recovery:** if a worker crashes, execution resumes from the exact point of failure without repeating completed operations incorrectly.
- **Idempotency:** re-executing failed steps yields identical outcomes safely.

---

## ✨ What Is Implemented

- **Durable state machine** backed by SQLite (`node:sqlite`) in WAL mode.
- **Atomic claims:** steps are leased inside `BEGIN IMMEDIATE` transactions.
- **Crash recovery:** expired worker leases are reclaimed and retried.
- **Stale-result fencing:** a worker that lost its lease cannot overwrite newer state.
- **Automatic retries** with configurable exponential backoff.
- **Saga compensation:** completed steps are undone in reverse order after a permanent failure.
- **Idempotency keys** passed to every step and compensation handler.
- **Observability:** append-only event log plus per-attempt history.
- **REST API** with idempotent run creation, listing, filtering, events, and cancellation.
- **Demo workflow** with injectable transient/permanent faults.
- **25 automated tests** covering the happy path, retries, compensation, cancellation, lease recovery, stale results, timeouts, idempotency, and persistence across restarts.

---

## 🏗️ Architecture

```
                    ┌──────────────────────────────┐
   HTTP clients ───►│  Fastify API                 │
                    │  /api/workflows, /api/runs   │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │  WorkflowService             │
                    │  create / query / cancel     │
                    └──────────────┬───────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
   ┌─────────────────────┐                   ┌─────────────────────┐
   │  WorkflowRegistry   │                   │  RunStore (SQLite)  │
   │  step definitions   │                   │  runs / steps /     │
   │  retry policies     │                   │  attempts / events  │
   └──────────┬──────────┘                   └──────────┬──────────┘
              │                                         │
              ▼                                         │
   ┌─────────────────────────────────────────────────── ▼ ────────┐
   │  WorkflowEngine (one or more workers)                        │
   │  claim → execute → persist → retry / compensate              │
   │  recover expired leases → retry or fail                      │
   └──────────────────────────────────────────────────────────────┘
```

### Run lifecycle

```
pending ──► running ──► completed
                │
                ├──► compensating ──► compensated   (failure rolled back)
                │
                └──► failed                        (compensation failed)

pending/running ──► cancelled                     (no rollback)
```

Each step moves through `pending → running → succeeded`, or on failure
`pending → running → pending` (retry) → … → `failed`. When a step fails
permanently, earlier `succeeded` steps become `pending_compensation →
compensating → compensated`, and later steps become `skipped`.

---

## 🔒 Durability & Correctness Model

### 1. Every transition is committed first

All state changes happen inside a single SQLite transaction:

- a step is claimed and an attempt row is inserted **before** its handler runs;
- success/failure is written **after** the handler returns;
- run-level transitions (`run.started`, `run.completed`, `run.compensating`, …) are written in the same transaction as the step transition.

If the process dies at any point, the database contains a complete picture of what was in flight.

### 2. Leases and crash recovery

A worker claims a step by setting `lease_owner` and `lease_expires_at`. Other
workers ignore it while the lease is valid. When a worker crashes, the lease
expires and any worker can reclaim the step:

- the interrupted attempt is marked `lease_expired`;
- the step is retried if attempts remain, otherwise it fails and compensation begins;
- a cancelled run's in-flight step is marked failed without starting a rollback.

### 3. Stale-result fencing

Completion updates are conditional:

```sql
UPDATE steps
SET status = 'succeeded', ...
WHERE id = ? AND status = 'running'
  AND lease_owner = ? AND attempts = ?
```

A zombie worker whose lease was taken over updates zero rows, so its result is
discarded instead of corrupting newer state.

### 4. Idempotency

Every step receives a stable key:

```
<runId>:<stepIndex>:<stepName>            # execution
<runId>:<stepIndex>:<stepName>:compensate # compensation
```

Handlers are expected to pass this key to downstream services. The demo
services store effects keyed by it, so retrying after a crash returns the
original reservation/charge instead of creating a duplicate.

### 5. Retries and backoff

Retry policy is resolved per step at run creation time and persisted with the
step:

```ts
{ maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 2000, backoffFactor: 2 }
```

`RetryableError` (or any unknown error) is retried; `PermanentError` skips
straight to compensation. Timeouts are retryable.

### 6. Saga compensation

When a step fails permanently, every earlier `succeeded` step is scheduled for
compensation. The engine executes them in **reverse order** and retries each
compensation with the same policy. If a compensation ultimately fails, the run
becomes `failed` and the failure is visible in the event log for manual
intervention.

### 7. Observability

The `events` table is an append-only audit log:

```
run.created, run.started, step.started, step.succeeded, step.retry_scheduled,
step.failed, step.compensation_scheduled, run.compensating,
step.compensation_started, step.compensated, run.compensated,
step.lease_expired, step.skipped, run.cancelled, run.failed, ...
```

Every execution attempt is also stored in `attempts` with worker id, status,
error, and timestamps.

---

## 🚀 Quick Start

Requires **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module; developed on Node 26).

```bash
npm install
npm run dev          # API on http://localhost:3000, worker enabled
```

Or build and run:

```bash
npm run build
npm start
```

The database defaults to `./data/durable.db` (created automatically).

### Configuration

| Variable              | Default            | Description                                  |
| --------------------- | ------------------ | -------------------------------------------- |
| `PORT`                | `3000`             | HTTP port                                    |
| `HOST`                | `0.0.0.0`          | HTTP bind address                            |
| `DATABASE_PATH`       | `./data/durable.db`| SQLite file (`:memory:` is supported)        |
| `WORKER_ENABLED`      | `true`             | Set to `false` to run API-only               |
| `POLL_INTERVAL_MS`    | `100`              | Worker poll interval                         |
| `LEASE_MS`            | `30000`            | Step lease duration before recovery          |
| `CONCURRENCY`         | `4`                | Max steps executed per tick                  |
| `STEP_TIMEOUT_MS`     | `30000`            | Default step timeout                         |
| `LOG_LEVEL`           | `info`             | Fastify/pino log level                       |

---

## 🔌 REST API

| Method | Path                                | Description                                      |
| ------ | ----------------------------------- | ------------------------------------------------ |
| GET    | `/health`                           | Liveness probe                                   |
| GET    | `/api/workflows`                    | Registered workflows and their steps             |
| POST   | `/api/workflows/:name/runs`         | Create a run (`202`; `200` if idempotency replay)|
| GET    | `/api/runs`                         | List runs (`status`, `workflow`, `limit`, `offset`) |
| GET    | `/api/runs/:id`                     | Run plus its steps                               |
| GET    | `/api/runs/:id/steps`               | Steps only                                       |
| GET    | `/api/runs/:id/events`              | Event log (`after`, `limit`)                     |
| POST   | `/api/runs/:id/cancel`              | Cancel a `pending`/`running` run                 |

### Create a run

```bash
curl -X POST http://localhost:3000/api/workflows/order-processing/runs \
  -H 'content-type: application/json' \
  -d '{
    "input": {
      "orderId": "order-1",
      "customerId": "customer-1",
      "items": [{ "sku": "sku-1", "quantity": 2 }],
      "amount": 49.5
    },
    "idempotencyKey": "checkout-order-1"
  }'
```

### Check status

```bash
curl http://localhost:3000/api/runs/<run-id>
```

```json
{
  "run": {
    "status": "completed",
    "output": { "shipmentId": "shp_1", "trackingNumber": "TRK-000001" }
  },
  "steps": [
    { "name": "reserve-inventory", "status": "succeeded", "attempts": 1 },
    { "name": "process-payment",   "status": "succeeded", "attempts": 1 },
    { "name": "arrange-shipping",  "status": "succeeded", "attempts": 1 }
  ]
}
```

---

## 🧪 Fault Injection Demo

The demo workflow accepts a `faults` map keyed by step name. Each entry can
simulate a transient failure, a permanent failure, or a slow service:

```json
{
  "faults": {
    "process-payment": { "failTimes": 2 },
    "arrange-shipping": { "permanent": true },
    "reserve-inventory": { "delayMs": 500 }
  }
}
```

- `failTimes: N` — first `N` attempts throw `RetryableError`.
- `permanent: true` — every attempt throws `PermanentError`.
- `delayMs: N` — delay the call (useful with step timeouts).

Compensation faults use `<step>:compensate`:

```json
{ "faults": { "process-payment:compensate": { "failTimes": 1 } } }
```

Run the full demo (happy path, permanent failure with rollback, transient retry):

```bash
npm run build
./scripts/demo.sh
```

---

## ✅ Tests

```bash
npm test
npm run typecheck
```

The suite covers:

- successful end-to-end execution and persisted outputs;
- transient failures retried with no duplicate charges;
- retry exhaustion followed by reverse-order compensation;
- permanent failures skipping retries;
- compensation failures and `failed` runs;
- cancellation before and during execution;
- lease expiry recovery after a simulated crash;
- stale results from a worker that lost its lease being discarded;
- step timeouts;
- idempotency-key replay at both the service and HTTP layers;
- persistence and recovery across a real database reopen;
- concurrent processing of multiple runs;
- API validation, filtering, events, and error responses.

---

## 📁 Project Layout

```
src/
  index.ts                  # bootstrap: config, DB, engine, HTTP server
  config.ts                 # environment configuration
  api/server.ts             # Fastify routes and error mapping
  db/database.ts            # node:sqlite connection, schema, transactions
  domain/types.ts           # run/step/attempt/event/retry types
  engine/
    engine.ts               # worker loop, timeouts, retry/compensation decisions
    store.ts                # all SQL, atomic claims, recovery, event log
    registry.ts             # workflow registration and retry policies
    workflow-service.ts     # create/query/cancel use cases
    errors.ts               # RetryableError, PermanentError, serialization
  workflows/
    order/workflow.ts       # reserve → pay → ship saga
    order/services.ts       # idempotent in-memory inventory/payment/shipping
scripts/demo.sh             # end-to-end HTTP demo
tests/                      # engine, workflow, API, and persistence tests
```

---

## 🧭 Design Notes & Limitations

- **SQLite is the durable store** for this slice. The store is deliberately
  isolated, so a Postgres adapter can replace it without touching the engine.
- **The demo services are in-memory.** They reset when the process restarts and
  are shared only within one process. Real adapters must persist idempotency
  records (or rely on the downstream provider's idempotency support).
- **Workflow version is recorded on each run** but the engine executes the
  currently registered definition. Schema/definition evolution is not enforced.
- **Cancellation is not rollback.** Cancelling stops future steps; it does not
  compensate completed ones. Trigger a failure if you need a rollback.
- **One SQLite writer at a time.** WAL + `busy_timeout` make multi-process
  workers safe, but this is not a horizontally scalable production database.

## 🗺️ Possible Next Steps

- Postgres store adapter and Docker Compose setup.
- Workflow definition versioning and migration rules.
- Prometheus metrics and a small status dashboard.
- Dead-letter queue / manual retry endpoint for `failed` runs.
- Delayed steps, child workflows, and parallel fan-out/fan-in.
- Property-based tests for the state machine.
