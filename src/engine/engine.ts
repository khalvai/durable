import { randomUUID } from "node:crypto";
import type {
  Clock,
  Logger,
  RetryPolicy,
  StepContext,
  StepDefinition,
} from "../domain/types.js";
import { StepTimeoutError, isRetryable, serializeError } from "./errors.js";
import { computeBackoffDelay, type WorkflowRegistry } from "./registry.js";
import type { ClaimedTask, RunStore } from "./store.js";

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface EngineOptions {
  store: RunStore;
  registry: WorkflowRegistry;
  clock?: Clock;
  workerId?: string;
  /** How long a worker owns a claimed step before another worker may reclaim it. */
  leaseMs?: number;
  /** Maximum number of steps executed concurrently per tick. */
  concurrency?: number;
  /** Delay between background polls. */
  pollIntervalMs?: number;
  /** Default per-step execution timeout. */
  defaultStepTimeoutMs?: number;
  logger?: Logger;
}

export interface TickResult {
  processed: number;
  recoveredLeases: number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

/**
 * Executes runnable steps.
 *
 * The engine is deliberately stateless: everything it needs lives in the
 * database. Multiple engine instances (workers) can point at the same database;
 * leases ensure only one of them executes a given step at a time.
 */
export class WorkflowEngine {
  private readonly store: RunStore;
  private readonly registry: WorkflowRegistry;
  private readonly clock: Clock;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly defaultStepTimeoutMs: number;
  private readonly logger: Logger;

  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private tickChain: Promise<unknown> = Promise.resolve();

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
    this.defaultStepTimeoutMs = options.defaultStepTimeoutMs ?? 30_000;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  now(): number {
    return this.clock.now();
  }

  /** Processes every step that is currently due, then returns. */
  async runUntilIdle(maxTicks = 1_000): Promise<void> {
    for (let i = 0; i < maxTicks; i += 1) {
      const result = await this.tick();
      if (result.processed === 0) return;
    }
    throw new Error(`runUntilIdle exceeded ${maxTicks} ticks; workflow may be looping`);
  }

  /**
   * Reclaims expired leases and executes up to `concurrency` due steps.
   * Calls are serialized so ticks never overlap.
   */
  tick(): Promise<TickResult> {
    const next = this.tickChain.then(() => this.doTick());
    this.tickChain = next.catch(() => undefined);
    return next;
  }

  private async doTick(): Promise<TickResult> {
    const recoveredLeases = this.store.recoverExpiredLeases(this.clock.now());

    const tasks: ClaimedTask[] = [];
    for (let i = 0; i < this.concurrency; i += 1) {
      const task = this.store.claimNext(this.workerId, this.clock.now(), this.leaseMs);
      if (!task) break;
      tasks.push(task);
    }

    const results = await Promise.allSettled(tasks.map((task) => this.executeTask(task)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error({ err: result.reason }, "Unexpected engine error while executing a step");
      }
    }
    return { processed: tasks.length, recoveredLeases };
  }

  /** Starts the background polling loop. Safe to call more than once. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops polling and waits for the current tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.tickChain.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runScheduled();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runScheduled(): Promise<void> {
    this.timer = undefined;
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (error) {
      this.logger.error({ err: error }, "Engine tick failed");
    }
    if (!this.stopped) this.schedule(this.pollIntervalMs);
  }

  private async executeTask(task: ClaimedTask): Promise<void> {
    const workflow = this.registry.get(task.workflowName);
    const step = workflow?.steps[task.stepIndex];
    if (!workflow || !step || step.name !== task.stepName) {
      const error = serializeError(
        new Error(
          `Workflow "${task.workflowName}" step #${task.stepIndex} ("${task.stepName}") is not registered`,
        ),
      );
      this.logger.error({ runId: task.runId, step: task.stepName, error }, "Unknown workflow step");
      if (task.kind === "execute") this.store.failStep(task, error, this.clock.now());
      else this.store.failCompensation(task, error, this.clock.now());
      return;
    }

    const input = JSON.parse(task.inputJson) as unknown;
    const outputs = this.store.getStepOutputs(task.runId);
    const idempotencyKey =
      task.kind === "execute" ? task.idempotencyKey : `${task.idempotencyKey}:compensate`;

    const context: StepContext = {
      runId: task.runId,
      workflowName: task.workflowName,
      stepName: task.stepName,
      stepIndex: task.stepIndex,
      attempt: task.attemptNumber,
      input,
      idempotencyKey,
      outputs,
      signal: new AbortController().signal,
      logger: this.logger,
    };

    try {
      if (task.kind === "execute") {
        const output = await this.invoke(
          step,
          context,
          (ctx) => step.execute(ctx),
        );
        const result = this.store.markStepSucceeded(task, output, this.clock.now());
        if (!result.applied) {
          this.logger.warn(
            { runId: task.runId, step: task.stepName },
            "Discarded stale step result (lease was lost)",
          );
        }
      } else {
        const output = outputs[task.stepName];
        if (step.compensate) {
          await this.invoke(step, context, (ctx) => step.compensate!(ctx, output));
        }
        const result = this.store.markCompensated(task, this.clock.now());
        if (!result.applied) {
          this.logger.warn(
            { runId: task.runId, step: task.stepName },
            "Discarded stale compensation result (lease was lost)",
          );
        }
      }
    } catch (error) {
      this.handleFailure(task, step, error);
    }
  }

  private async invoke<T>(
    step: StepDefinition,
    context: StepContext,
    fn: (context: StepContext) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = step.timeoutMs ?? this.defaultStepTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new StepTimeoutError(step.name, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([fn({ ...context, signal: controller.signal }), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handleFailure(task: ClaimedTask, step: StepDefinition, error: unknown): void {
    const now = this.clock.now();
    const serialized = serializeError(error);
    const retryable = isRetryable(error);

    if (task.kind === "execute") {
      const attemptsLeft = task.attempts < task.maxAttempts;
      if (retryable && attemptsLeft) {
        const delay = computeBackoffDelay(task.retry, task.attempts);
        const nextAttemptAt = now + delay;
        this.store.scheduleRetry(task, serialized, nextAttemptAt, now);
        this.logger.warn(
          {
            runId: task.runId,
            step: task.stepName,
            attempt: task.attemptNumber,
            nextAttemptAt,
            error: serialized,
          },
          "Step failed; retry scheduled",
        );
      } else {
        this.logger.error(
          {
            runId: task.runId,
            step: task.stepName,
            attempt: task.attemptNumber,
            error: serialized,
          },
          "Step failed permanently; starting compensation",
        );
        this.store.failStep(task, serialized, now);
      }
      return;
    }

    const attemptsLeft = task.compensationAttempts < task.maxAttempts;
    if (retryable && attemptsLeft) {
      const delay = computeBackoffDelay(task.retry, task.compensationAttempts);
      const nextAttemptAt = now + delay;
      this.store.scheduleCompensationRetry(task, serialized, nextAttemptAt, now);
      this.logger.warn(
        {
          runId: task.runId,
          step: task.stepName,
          attempt: task.attemptNumber,
          nextAttemptAt,
          error: serialized,
        },
        "Compensation failed; retry scheduled",
      );
    } else {
      this.logger.error(
        {
          runId: task.runId,
          step: task.stepName,
          attempt: task.attemptNumber,
          error: serialized,
        },
        "Compensation failed permanently",
      );
      this.store.failCompensation(task, serialized, now);
    }
  }
}

export type { RetryPolicy };
