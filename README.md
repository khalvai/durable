# Reliable Workflow Engine / Distributed Task Orchestrator

A prjoect for subject of _Software Verification_, there will be soon codes for engine.

A fault-tolerant backend system designed to execute multi-step, long-running processes reliably—ensuring state persistence, graceful recovery from server crashes, and consistent execution.

---

## 💡 Problem & Purpose

In backend systems, many business processes consist of multiple dependent tasks that must execute reliably, often spanning extended periods.

Consider a standard **Order-Processing Workflow**:

1. **Reserve Inventory**
2. **Process Payment**
3. **Arrange Shipping**

If a server crashes or an external service fails midway through this sequence, a basic implementation risks losing state, double-charging customers, or failing to fulfill orders.

This project provides a robust orchestration layer that guarantees:

- **Durability:** Every state transition is recorded before moving forward.
- **Fault Tolerance & Recovery:** If a node crashes, execution resumes from the exact point of failure without repeating previously completed operations incorrectly.
- **Idempotency:** Re-executing failed steps yields identical outcomes safely.

---

## ✨ Key Features

- **State Persistence:** Tracks execution history across system restarts and crashes.
- **Automatic Retries & Backoff:** Configurable retry policies for transient network or third-party API failures.
- **Compensation & Rollback:** Supports compensating actions (e.g., releasing inventory if payment processing fails).
- **Observability:** Centralized logging and status tracking for long-running workflows.

---

## 🏗️ Architecture & Workflow

```
[ Trigger Event ]
        │
        ▼
┌──────────────────┐
│ Reserve Inventory│ ──(Success)──► [ Save State ]
└──────────────────┘                      │
                                          ▼
                                ┌──────────────────┐
                                │  Process Payment │ ──(Crash / Retry)
                                └──────────────────┘
                                          │
                                      (Success)
                                          │
                                          ▼
                                ┌──────────────────┐
                                │ Arrange Shipping │
                                └──────────────────┘
```

When a failure occurs, the orchestrator detects the stoppage and resumes execution from the last saved state checkpoint.
