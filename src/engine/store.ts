import { randomUUID } from "node:crypto";
import type {
  Attempt,
  AttemptKind,
  CreateRunResult,
  ListRunsOptions,
  RetryPolicy,
  Run,
  RunDetail,
  RunStatus,
  SerializedError,
  Step,
  StepStatus,
  WorkflowEvent,
} from "../domain/types.js";
import { changesOf, type Database } from "../db/database.js";

interface RunRow {
  id: string;
  workflow_name: string;
  workflow_version: number;
  status: RunStatus;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface StepRow {
  id: string;
  run_id: string;
  step_index: number;
  name: string;
  status: StepStatus;
  attempts: number;
  max_attempts: number;
  compensation_attempts: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  idempotency_key: string;
  retry_json: string;
  output_json: string | null;
  error_json: string | null;
  started_at: number | null;
  finished_at: number | null;
}

interface EventRow {
  seq: number;
  run_id: string;
  step_id: string | null;
  type: string;
  data_json: string | null;
  created_at: number;
}

interface AttemptRow {
  id: string;
  step_id: string;
  kind: AttemptKind;
  attempt_number: number;
  worker_id: string;
  status: Attempt["status"];
  error_json: string | null;
  started_at: number;
  finished_at: number | null;
}

export interface StepSpec {
  id: string;
  index: number;
  name: string;
  idempotencyKey: string;
  retry: RetryPolicy;
}

export interface CreateRunParams {
  id: string;
  workflowName: string;
  workflowVersion: number;
  input: unknown;
  idempotencyKey: string | null;
  steps: StepSpec[];
  now: number;
}

export interface ClaimedTask {
  runId: string;
  runStatus: RunStatus;
  workflowName: string;
  inputJson: string;
  stepId: string;
  stepIndex: number;
  stepName: string;
  idempotencyKey: string;
  kind: AttemptKind;
  attemptId: string;
  attemptNumber: number;
  attempts: number;
  maxAttempts: number;
  compensationAttempts: number;
  retry: RetryPolicy;
  workerId: string;
  leaseExpiresAt: number;
}

export interface CompletionResult {
  applied: boolean;
  runStatus: RunStatus | null;
}

function parseJson<T>(value: string | null): T | null {
  if (value === null) return null;
  return JSON.parse(value) as T;
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    status: row.status,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    error: parseJson<SerializedError>(row.error_json),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function mapStep(row: StepRow): Step {
  return {
    id: row.id,
    runId: row.run_id,
    index: row.step_index,
    name: row.name,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    compensationAttempts: row.compensation_attempts,
    nextAttemptAt: row.next_attempt_at,
    idempotencyKey: row.idempotency_key,
    output: parseJson(row.output_json),
    error: parseJson<SerializedError>(row.error_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapEvent(row: EventRow): WorkflowEvent {
  return {
    seq: row.seq,
    runId: row.run_id,
    stepId: row.step_id,
    type: row.type,
    data: parseJson<Record<string, unknown>>(row.data_json),
    createdAt: row.created_at,
  };
}

function mapAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    stepId: row.step_id,
    kind: row.kind,
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    status: row.status,
    error: parseJson<SerializedError>(row.error_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * All SQL lives here. Every method that changes durable state does so inside a
 * single transaction so a crash can never leave a half-written transition.
 */
export class RunStore {
  constructor(private readonly database: Database) {}

  createRun(params: CreateRunParams): Run {
    const { now } = params;
    this.database.transaction(() => {
      this.database.handle
        .prepare(
          `INSERT INTO runs
             (id, workflow_name, workflow_version, status, input_json, output_json,
              error_json, idempotency_key, created_at, updated_at, finished_at)
           VALUES (?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?, NULL)`,
        )
        .run(
          params.id,
          params.workflowName,
          params.workflowVersion,
          JSON.stringify(params.input ?? null),
          params.idempotencyKey,
          now,
          now,
        );

      const insertStep = this.database.handle.prepare(
        `INSERT INTO steps
           (id, run_id, step_index, name, status, attempts, max_attempts,
            compensation_attempts, next_attempt_at, lease_owner, lease_expires_at,
            idempotency_key, retry_json, output_json, error_json, started_at, finished_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, 0, ?, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
      );
      for (const step of params.steps) {
        insertStep.run(
          step.id,
          params.id,
          step.index,
          step.name,
          step.retry.maxAttempts,
          now,
          step.idempotencyKey,
          JSON.stringify(step.retry),
        );
      }

      this.appendEvent(params.id, null, "run.created", {
        workflowName: params.workflowName,
        workflowVersion: params.workflowVersion,
      }, now);
    });
    const run = this.findRunById(params.id);
    if (!run) throw new Error(`Run ${params.id} disappeared after insert`);
    return run;
  }

  findRunById(id: string): Run | null {
    const row = this.database.handle.prepare("SELECT * FROM runs WHERE id = ?").get(id) as
      | RunRow
      | undefined;
    return row ? mapRun(row) : null;
  }

  findRunByIdempotencyKey(key: string): Run | null {
    const row = this.database.handle
      .prepare("SELECT * FROM runs WHERE idempotency_key = ?")
      .get(key) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  getRunDetail(id: string): RunDetail | null {
    const run = this.findRunById(id);
    if (!run) return null;
    return { run, steps: this.getSteps(id) };
  }

  listRuns(options: ListRunsOptions = {}): { runs: Run[]; total: number } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const clauses: string[] = [];
    const values: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      values.push(options.status);
    }
    if (options.workflowName) {
      clauses.push("workflow_name = ?");
      values.push(options.workflowName);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = this.database.handle
      .prepare(`SELECT COUNT(*) AS count FROM runs ${where}`)
      .get(...values) as { count: number };
    const rows = this.database.handle
      .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as RunRow[];
    return { runs: rows.map(mapRun), total: Number(totalRow.count) };
  }

  getSteps(runId: string): Step[] {
    const rows = this.database.handle
      .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step_index ASC")
      .all(runId) as unknown as StepRow[];
    return rows.map(mapStep);
  }

  getStepOutputs(runId: string): Record<string, unknown> {
    const rows = this.database.handle
      .prepare(
        `SELECT name, output_json FROM steps
         WHERE run_id = ? AND output_json IS NOT NULL
         ORDER BY step_index ASC`,
      )
      .all(runId) as unknown as { name: string; output_json: string }[];
    const outputs: Record<string, unknown> = {};
    for (const row of rows) outputs[row.name] = parseJson(row.output_json);
    return outputs;
  }

  getEvents(runId: string, afterSeq = 0, limit = 1_000): WorkflowEvent[] {
    const rows = this.database.handle
      .prepare(
        `SELECT * FROM events
         WHERE run_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(runId, afterSeq, Math.min(Math.max(limit, 1), 5_000)) as unknown as EventRow[];
    return rows.map(mapEvent);
  }

  getAttempts(stepId: string): Attempt[] {
    const rows = this.database.handle
      .prepare("SELECT * FROM attempts WHERE step_id = ? ORDER BY started_at ASC")
      .all(stepId) as unknown as AttemptRow[];
    return rows.map(mapAttempt);
  }

  /**
   * Atomically leases the next runnable step. Forward steps are preferred over
   * compensations. Returns null when nothing is due.
   */
  claimNext(workerId: string, now: number, leaseMs: number): ClaimedTask | null {
    return this.database.transaction(() => {
      const forward = this.database.handle
        .prepare(
          `SELECT s.*, r.workflow_name, r.input_json, r.status AS run_status
           FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.status = 'pending'
             AND s.next_attempt_at <= ?
             AND r.status IN ('pending', 'running')
             AND (s.step_index = 0 OR EXISTS (
               SELECT 1 FROM steps p
               WHERE p.run_id = s.run_id
                 AND p.step_index = s.step_index - 1
                 AND p.status = 'succeeded'
             ))
           ORDER BY r.created_at ASC, s.step_index ASC
           LIMIT 1`,
        )
        .get(now) as (StepRow & { workflow_name: string; input_json: string; run_status: RunStatus }) | undefined;

      if (forward) return this.claimForward(forward, workerId, now, leaseMs);

      const compensation = this.database.handle
        .prepare(
          `SELECT s.*, r.workflow_name, r.input_json, r.status AS run_status
           FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.status = 'pending_compensation'
             AND s.next_attempt_at <= ?
             AND r.status = 'compensating'
             AND NOT EXISTS (
               SELECT 1 FROM steps h
               WHERE h.run_id = s.run_id
                 AND h.step_index > s.step_index
                 AND h.status IN ('pending_compensation', 'compensating')
             )
           ORDER BY r.updated_at ASC, s.step_index DESC
           LIMIT 1`,
        )
        .get(now) as (StepRow & { workflow_name: string; input_json: string; run_status: RunStatus }) | undefined;

      if (compensation) return this.claimCompensation(compensation, workerId, now, leaseMs);
      return null;
    });
  }

  private claimForward(
    row: StepRow & { workflow_name: string; input_json: string; run_status: RunStatus },
    workerId: string,
    now: number,
    leaseMs: number,
  ): ClaimedTask | null {
    const leaseExpiresAt = now + leaseMs;
    const updated = this.database.handle
      .prepare(
        `UPDATE steps
         SET status = 'running', lease_owner = ?, lease_expires_at = ?,
             attempts = attempts + 1, started_at = COALESCE(started_at, ?),
             error_json = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(workerId, leaseExpiresAt, now, row.id);
    if (changesOf(updated) === 0) return null;

    const attemptId = randomUUID();
    const attemptNumber = row.attempts + 1;
    this.database.handle
      .prepare(
        `INSERT INTO attempts
           (id, step_id, kind, attempt_number, worker_id, status, error_json, started_at, finished_at)
         VALUES (?, ?, 'execute', ?, ?, 'running', NULL, ?, NULL)`,
      )
      .run(attemptId, row.id, attemptNumber, workerId, now);

    this.database.handle
      .prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(now, row.run_id);
    if (row.run_status === "pending") {
      this.appendEvent(row.run_id, null, "run.started", null, now);
    }
    this.appendEvent(row.run_id, row.id, "step.started", { attempt: attemptNumber }, now);

    return {
      runId: row.run_id,
      runStatus: row.run_status === "pending" ? "running" : row.run_status,
      workflowName: row.workflow_name,
      inputJson: row.input_json,
      stepId: row.id,
      stepIndex: row.step_index,
      stepName: row.name,
      idempotencyKey: row.idempotency_key,
      kind: "execute",
      attemptId,
      attemptNumber,
      attempts: attemptNumber,
      maxAttempts: row.max_attempts,
      compensationAttempts: row.compensation_attempts,
      retry: parseJson<RetryPolicy>(row.retry_json) ?? { maxAttempts: row.max_attempts, initialDelayMs: 1_000, maxDelayMs: 30_000, backoffFactor: 2 },
      workerId,
      leaseExpiresAt,
    };
  }

  private claimCompensation(
    row: StepRow & { workflow_name: string; input_json: string; run_status: RunStatus },
    workerId: string,
    now: number,
    leaseMs: number,
  ): ClaimedTask | null {
    const leaseExpiresAt = now + leaseMs;
    const updated = this.database.handle
      .prepare(
        `UPDATE steps
         SET status = 'compensating', lease_owner = ?, lease_expires_at = ?,
             compensation_attempts = compensation_attempts + 1, error_json = NULL
         WHERE id = ? AND status = 'pending_compensation'`,
      )
      .run(workerId, leaseExpiresAt, row.id);
    if (changesOf(updated) === 0) return null;

    const attemptId = randomUUID();
    const attemptNumber = row.compensation_attempts + 1;
    this.database.handle
      .prepare(
        `INSERT INTO attempts
           (id, step_id, kind, attempt_number, worker_id, status, error_json, started_at, finished_at)
         VALUES (?, ?, 'compensate', ?, ?, 'running', NULL, ?, NULL)`,
      )
      .run(attemptId, row.id, attemptNumber, workerId, now);

    this.appendEvent(row.run_id, row.id, "step.compensation_started", { attempt: attemptNumber }, now);

    return {
      runId: row.run_id,
      runStatus: row.run_status,
      workflowName: row.workflow_name,
      inputJson: row.input_json,
      stepId: row.id,
      stepIndex: row.step_index,
      stepName: row.name,
      idempotencyKey: row.idempotency_key,
      kind: "compensate",
      attemptId,
      attemptNumber,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      compensationAttempts: attemptNumber,
      retry: parseJson<RetryPolicy>(row.retry_json) ?? { maxAttempts: row.max_attempts, initialDelayMs: 1_000, maxDelayMs: 30_000, backoffFactor: 2 },
      workerId,
      leaseExpiresAt,
    };
  }

  markStepSucceeded(task: ClaimedTask, output: unknown, now: number): CompletionResult {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE steps
           SET status = 'succeeded', output_json = ?, finished_at = ?,
               lease_owner = NULL, lease_expires_at = NULL, error_json = NULL
           WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempts = ?`,
        )
        .run(JSON.stringify(output ?? null), now, task.stepId, task.workerId, task.attempts);
      if (changesOf(updated) === 0) {
        this.supersedeAttempt(task.attemptId, now);
        return { applied: false, runStatus: null };
      }
      this.finishAttempt(task.attemptId, "succeeded", null, now);
      this.appendEvent(task.runId, task.stepId, "step.succeeded", { attempt: task.attemptNumber }, now);

      const count = this.database.handle
        .prepare("SELECT COUNT(*) AS count FROM steps WHERE run_id = ?")
        .get(task.runId) as { count: number };
      const isLast = task.stepIndex === Number(count.count) - 1;
      if (!isLast) return { applied: true, runStatus: null };

      const runUpdated = this.database.handle
        .prepare(
          `UPDATE runs
           SET status = 'completed', output_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'running')`,
        )
        .run(JSON.stringify(output ?? null), now, now, task.runId);
      if (changesOf(runUpdated) > 0) {
        this.appendEvent(task.runId, null, "run.completed", null, now);
        return { applied: true, runStatus: "completed" };
      }
      return { applied: true, runStatus: null };
    });
  }

  scheduleRetry(
    task: ClaimedTask,
    error: SerializedError,
    nextAttemptAt: number,
    now: number,
  ): boolean {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE steps
           SET status = 'pending', next_attempt_at = ?, error_json = ?,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempts = ?`,
        )
        .run(nextAttemptAt, JSON.stringify(error), task.stepId, task.workerId, task.attempts);
      if (changesOf(updated) === 0) {
        this.supersedeAttempt(task.attemptId, now);
        return false;
      }
      this.finishAttempt(task.attemptId, "failed", error, now);
      this.appendEvent(task.runId, task.stepId, "step.retry_scheduled", {
        attempt: task.attemptNumber,
        nextAttemptAt,
        error,
      }, now);
      return true;
    });
  }

  /** Marks the step as permanently failed and starts saga compensation. */
  failStep(task: ClaimedTask, error: SerializedError, now: number): RunStatus {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE steps
           SET status = 'failed', finished_at = ?, error_json = ?,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'running' AND lease_owner = ? AND attempts = ?`,
        )
        .run(now, JSON.stringify(error), task.stepId, task.workerId, task.attempts);
      if (changesOf(updated) === 0) {
        this.supersedeAttempt(task.attemptId, now);
        return this.findRunById(task.runId)?.status ?? "failed";
      }
      this.finishAttempt(task.attemptId, "failed", error, now);
      this.appendEvent(task.runId, task.stepId, "step.failed", {
        attempt: task.attemptNumber,
        error,
      }, now);
      return this.beginCompensation(task.runId, task.stepIndex, error, now);
    });
  }

  markCompensated(task: ClaimedTask, now: number): CompletionResult {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE steps
           SET status = 'compensated', finished_at = ?,
               lease_owner = NULL, lease_expires_at = NULL, error_json = NULL
           WHERE id = ? AND status = 'compensating' AND lease_owner = ?
             AND compensation_attempts = ?`,
        )
        .run(now, task.stepId, task.workerId, task.compensationAttempts);
      if (changesOf(updated) === 0) {
        this.supersedeAttempt(task.attemptId, now);
        return { applied: false, runStatus: null };
      }
      this.finishAttempt(task.attemptId, "succeeded", null, now);
      this.appendEvent(task.runId, task.stepId, "step.compensated", {
        attempt: task.attemptNumber,
      }, now);

      const remaining = this.database.handle
        .prepare(
          `SELECT COUNT(*) AS count FROM steps
           WHERE run_id = ? AND status IN ('pending_compensation', 'compensating')`,
        )
        .get(task.runId) as { count: number };
      if (Number(remaining.count) > 0) return { applied: true, runStatus: null };

      const runUpdated = this.database.handle
        .prepare(
          `UPDATE runs SET status = 'compensated', finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'compensating'`,
        )
        .run(now, now, task.runId);
      if (changesOf(runUpdated) > 0) {
        this.appendEvent(task.runId, null, "run.compensated", null, now);
        return { applied: true, runStatus: "compensated" };
      }
      return { applied: true, runStatus: null };
    });
  }

  scheduleCompensationRetry(
    task: ClaimedTask,
    error: SerializedError,
    nextAttemptAt: number,
    now: number,
  ): boolean {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE steps
           SET status = 'pending_compensation', next_attempt_at = ?, error_json = ?,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'compensating' AND lease_owner = ?
             AND compensation_attempts = ?`,
        )
        .run(nextAttemptAt, JSON.stringify(error), task.stepId, task.workerId, task.compensationAttempts);
      if (changesOf(updated) === 0) {
        this.supersedeAttempt(task.attemptId, now);
        return false;
      }
      this.finishAttempt(task.attemptId, "failed", error, now);
      this.appendEvent(task.runId, task.stepId, "step.compensation_retry_scheduled", {
        attempt: task.attemptNumber,
        nextAttemptAt,
        error,
      }, now);
      return true;
    });
  }

  failCompensation(task: ClaimedTask, error: SerializedError, now: number): RunStatus {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE steps
           SET status = 'compensation_failed', finished_at = ?, error_json = ?,
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status = 'compensating' AND lease_owner = ?
             AND compensation_attempts = ?`,
        )
        .run(now, JSON.stringify(error), task.stepId, task.workerId, task.compensationAttempts);
      if (changesOf(updated) === 0) {
        this.supersedeAttempt(task.attemptId, now);
        return this.findRunById(task.runId)?.status ?? "failed";
      }
      this.finishAttempt(task.attemptId, "failed", error, now);
      this.appendEvent(task.runId, task.stepId, "step.compensation_failed", {
        attempt: task.attemptNumber,
        error,
      }, now);

      const pending = this.database.handle
        .prepare(
          `SELECT id FROM steps
           WHERE run_id = ? AND status = 'pending_compensation'`,
        )
        .all(task.runId) as unknown as { id: string }[];
      for (const step of pending) {
        this.database.handle
          .prepare("UPDATE steps SET status = 'skipped', finished_at = ? WHERE id = ?")
          .run(now, step.id);
        this.appendEvent(task.runId, step.id, "step.skipped", { reason: "compensation_failed" }, now);
      }

      this.database.handle
        .prepare(
          `UPDATE runs SET status = 'failed', error_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'compensating'`,
        )
        .run(JSON.stringify(error), now, now, task.runId);
      this.appendEvent(task.runId, null, "run.failed", { reason: "compensation_failed", error }, now);
      return "failed";
    });
  }

  /**
   * Reclaims steps whose worker lease expired (the worker crashed or was
   * partitioned). A reclaimed step is retried, or failed if it has exhausted
   * its attempts.
   */
  recoverExpiredLeases(now: number): number {
    return this.database.transaction(() => {
      const expired = this.database.handle
        .prepare(
          `SELECT s.*, r.status AS run_status FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.status IN ('running', 'compensating')
             AND s.lease_expires_at IS NOT NULL
             AND s.lease_expires_at <= ?
             AND r.status IN ('pending', 'running', 'compensating', 'cancelled')`,
        )
        .all(now) as unknown as (StepRow & { run_status: RunStatus })[];

      for (const step of expired) {
        const runningAttempt = this.database.handle
          .prepare(
            `SELECT * FROM attempts
             WHERE step_id = ? AND status = 'running'
             ORDER BY started_at DESC LIMIT 1`,
          )
          .get(step.id) as AttemptRow | undefined;
        if (runningAttempt) {
          this.finishAttempt(runningAttempt.id, "lease_expired", {
            name: "LeaseExpiredError",
            message: "The worker did not finish before its lease expired",
          }, now);
        }

        if (step.status === "running") {
          if (step.run_status === "cancelled") {
            const error: SerializedError = {
              name: "LeaseExpiredError",
              message: "The run was cancelled while this step was executing",
              code: "LEASE_EXPIRED",
            };
            this.database.handle
              .prepare(
                `UPDATE steps SET status = 'failed', finished_at = ?, error_json = ?,
                   lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`,
              )
              .run(now, JSON.stringify(error), step.id);
            this.appendEvent(step.run_id, step.id, "step.failed", {
              attempt: step.attempts,
              error,
            }, now);
            continue;
          }
          if (step.attempts >= step.max_attempts) {
            const error: SerializedError = {
              name: "LeaseExpiredError",
              message: `Step lease expired after ${step.attempts} attempt(s)`,
              code: "LEASE_EXPIRED",
            };
            this.database.handle
              .prepare(
                `UPDATE steps SET status = 'failed', finished_at = ?, error_json = ?,
                   lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`,
              )
              .run(now, JSON.stringify(error), step.id);
            this.appendEvent(step.run_id, step.id, "step.failed", {
              attempt: step.attempts,
              error,
            }, now);
            this.beginCompensation(step.run_id, step.step_index, error, now);
          } else {
            this.database.handle
              .prepare(
                `UPDATE steps SET status = 'pending', next_attempt_at = ?,
                   lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`,
              )
              .run(now, step.id);
            this.appendEvent(step.run_id, step.id, "step.lease_expired", {
              attempts: step.attempts,
              action: "retry",
            }, now);
          }
        } else {
          if (step.compensation_attempts >= step.max_attempts) {
            const error: SerializedError = {
              name: "LeaseExpiredError",
              message: `Compensation lease expired after ${step.compensation_attempts} attempt(s)`,
              code: "LEASE_EXPIRED",
            };
            this.database.handle
              .prepare(
                `UPDATE steps SET status = 'compensation_failed', finished_at = ?, error_json = ?,
                   lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`,
              )
              .run(now, JSON.stringify(error), step.id);
            this.appendEvent(step.run_id, step.id, "step.compensation_failed", {
              attempt: step.compensation_attempts,
              error,
            }, now);
            const remaining = this.database.handle
              .prepare(
                `SELECT id FROM steps
                 WHERE run_id = ? AND status = 'pending_compensation'`,
              )
              .all(step.run_id) as unknown as { id: string }[];
            for (const pending of remaining) {
              this.database.handle
                .prepare("UPDATE steps SET status = 'skipped', finished_at = ? WHERE id = ?")
                .run(now, pending.id);
              this.appendEvent(step.run_id, pending.id, "step.skipped", {
                reason: "compensation_failed",
              }, now);
            }
            this.database.handle
              .prepare(
                `UPDATE runs SET status = 'failed', error_json = ?, finished_at = ?, updated_at = ?
                 WHERE id = ? AND status = 'compensating'`,
              )
              .run(JSON.stringify(error), now, now, step.run_id);
            this.appendEvent(step.run_id, null, "run.failed", {
              reason: "compensation_failed",
              error,
            }, now);
          } else {
            this.database.handle
              .prepare(
                `UPDATE steps SET status = 'pending_compensation', next_attempt_at = ?,
                   lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`,
              )
              .run(now, step.id);
            this.appendEvent(step.run_id, step.id, "step.lease_expired", {
              attempts: step.compensation_attempts,
              action: "retry_compensation",
            }, now);
          }
        }
      }
      return expired.length;
    });
  }

  cancelRun(runId: string, now: number): boolean {
    return this.database.transaction(() => {
      const updated = this.database.handle
        .prepare(
          `UPDATE runs SET status = 'cancelled', finished_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'running')`,
        )
        .run(now, now, runId);
      if (changesOf(updated) === 0) return false;

      const pending = this.database.handle
        .prepare("SELECT id FROM steps WHERE run_id = ? AND status = 'pending'")
        .all(runId) as unknown as { id: string }[];
      for (const step of pending) {
        this.database.handle
          .prepare("UPDATE steps SET status = 'skipped', finished_at = ? WHERE id = ?")
          .run(now, step.id);
        this.appendEvent(runId, step.id, "step.skipped", { reason: "run_cancelled" }, now);
      }
      this.appendEvent(runId, null, "run.cancelled", null, now);
      return true;
    });
  }

  /** Earliest time at which any actually claimable step becomes due. */
  nextRunnableAt(): number | null {
    const row = this.database.handle
      .prepare(
        `SELECT MIN(next_at) AS next FROM (
           SELECT s.next_attempt_at AS next_at
           FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.status = 'pending'
             AND r.status IN ('pending', 'running')
             AND (s.step_index = 0 OR EXISTS (
               SELECT 1 FROM steps p
               WHERE p.run_id = s.run_id
                 AND p.step_index = s.step_index - 1
                 AND p.status = 'succeeded'
             ))
           UNION ALL
           SELECT s.next_attempt_at AS next_at
           FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.status = 'pending_compensation'
             AND r.status = 'compensating'
             AND NOT EXISTS (
               SELECT 1 FROM steps h
               WHERE h.run_id = s.run_id
                 AND h.step_index > s.step_index
                 AND h.status IN ('pending_compensation', 'compensating')
             )
         )`,
      )
      .get() as { next: number | null } | undefined;
    return row?.next ?? null;
  }

  private beginCompensation(
    runId: string,
    failedStepIndex: number,
    error: SerializedError,
    now: number,
  ): RunStatus {
    const current = this.database.handle
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(runId) as { status: RunStatus } | undefined;
    if (!current) return "failed";
    // A cancelled run is terminal; do not start a rollback for it.
    if (current.status !== "pending" && current.status !== "running") return current.status;

    const later = this.database.handle
      .prepare(
        `SELECT id FROM steps
         WHERE run_id = ? AND step_index > ? AND status = 'pending'`,
      )
      .all(runId, failedStepIndex) as unknown as { id: string }[];
    for (const step of later) {
      this.database.handle
        .prepare("UPDATE steps SET status = 'skipped', finished_at = ? WHERE id = ?")
        .run(now, step.id);
      this.appendEvent(runId, step.id, "step.skipped", { reason: "workflow_failed" }, now);
    }

    const completed = this.database.handle
      .prepare(
        `SELECT id, step_index FROM steps
         WHERE run_id = ? AND step_index < ? AND status = 'succeeded'
         ORDER BY step_index DESC`,
      )
      .all(runId, failedStepIndex) as unknown as { id: string; step_index: number }[];
    for (const step of completed) {
      this.database.handle
        .prepare(
          "UPDATE steps SET status = 'pending_compensation', next_attempt_at = ? WHERE id = ?",
        )
        .run(now, step.id);
      this.appendEvent(runId, step.id, "step.compensation_scheduled", null, now);
    }

    this.database.handle
      .prepare(
        `UPDATE runs SET status = 'compensating', error_json = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(JSON.stringify(error), now, runId);
    this.appendEvent(runId, null, "run.compensating", { error }, now);

    if (completed.length === 0) {
      this.database.handle
        .prepare(
          `UPDATE runs SET status = 'compensated', finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'compensating'`,
        )
        .run(now, now, runId);
      this.appendEvent(runId, null, "run.compensated", { note: "no completed steps to compensate" }, now);
      return "compensated";
    }
    return "compensating";
  }

  private finishAttempt(
    attemptId: string,
    status: Attempt["status"],
    error: SerializedError | null,
    now: number,
  ): void {
    this.database.handle
      .prepare(
        `UPDATE attempts SET status = ?, error_json = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, error ? JSON.stringify(error) : null, now, attemptId);
  }

  private supersedeAttempt(attemptId: string, now: number): void {
    this.finishAttempt(attemptId, "superseded", {
      name: "SupersededError",
      message: "A newer worker took over this step; this result was discarded",
    }, now);
  }

  private appendEvent(
    runId: string,
    stepId: string | null,
    type: string,
    data: Record<string, unknown> | null,
    now: number,
  ): void {
    this.database.handle
      .prepare(
        `INSERT INTO events (run_id, step_id, type, data_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, stepId, type, data ? JSON.stringify(data) : null, now);
  }
}

export { mapAttempt };
