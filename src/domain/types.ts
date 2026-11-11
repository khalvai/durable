/**
 * Core domain types for the durable workflow engine.
 *
 * A workflow is a sequence of steps (a saga). Steps run in order, and when a
 * step fails permanently the engine runs the compensating actions of already
 * completed steps in reverse order.
 */

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "compensating"
  | "compensated"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "pending_compensation"
  | "compensating"
  | "compensated"
  | "compensation_failed";

export type AttemptKind = "execute" | "compensate";

export type AttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "lease_expired"
  | "superseded";

export interface RetryPolicy {
  /** Total number of execution attempts, including the first one. */
  maxAttempts: number;
  /** Delay before the first retry, in milliseconds. */
  initialDelayMs: number;
  /** Upper bound for the exponential backoff delay. */
  maxDelayMs: number;
  /** Multiplier applied after every failed attempt. */
  backoffFactor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
};

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Clock {
  now(): number;
}

export interface StepContext<Input = unknown> {
  runId: string;
  workflowName: string;
  stepName: string;
  stepIndex: number;
  /** 1-based attempt number for this execution (or compensation). */
  attempt: number;
  input: Input;
  /**
   * Stable key for this step within the run. Pass it to external services so
   * that retries after a crash are deduplicated instead of repeated.
   */
  idempotencyKey: string;
  /** Outputs of previously completed steps, keyed by step name. */
  outputs: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  logger: Logger;
}

export interface StepDefinition<Input = unknown, Output = unknown> {
  name: string;
  execute(ctx: StepContext<Input>): Promise<Output>;
  /**
   * Undo the side effects of `execute`. Compensation is retried using the same
   * retry policy and receives a stable `:compensate` idempotency key.
   */
  compensate?(ctx: StepContext<Input>, output: Output): Promise<void>;
  /** Overrides the workflow-level retry policy for this step. */
  retry?: Partial<RetryPolicy>;
  /** Overrides the engine-level default timeout for this step. */
  timeoutMs?: number;
}

export interface WorkflowDefinition<Input = unknown> {
  name: string;
  version?: number;
  /** Applied to every step unless the step overrides it. */
  defaultRetry?: Partial<RetryPolicy>;
  steps: StepDefinition<Input, unknown>[];
}

export interface Run {
  id: string;
  workflowName: string;
  workflowVersion: number;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface Step {
  id: string;
  runId: string;
  index: number;
  name: string;
  status: StepStatus;
  attempts: number;
  maxAttempts: number;
  compensationAttempts: number;
  nextAttemptAt: number;
  idempotencyKey: string;
  output: unknown;
  error: SerializedError | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Attempt {
  id: string;
  stepId: string;
  kind: AttemptKind;
  attemptNumber: number;
  workerId: string;
  status: AttemptStatus;
  error: SerializedError | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface WorkflowEvent {
  seq: number;
  runId: string;
  stepId: string | null;
  type: string;
  data: Record<string, unknown> | null;
  createdAt: number;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  details?: unknown;
}

export interface RunDetail {
  run: Run;
  steps: Step[];
}

export interface ListRunsOptions {
  status?: RunStatus;
  workflowName?: string;
  limit?: number;
  offset?: number;
}

export interface CreateRunResult {
  run: Run;
  steps: Step[];
  created: boolean;
}
