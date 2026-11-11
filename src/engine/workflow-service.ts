import { randomUUID } from "node:crypto";
import type {
  Clock,
  CreateRunResult,
  ListRunsOptions,
  RunDetail,
  WorkflowEvent,
} from "../domain/types.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { resolveRetryPolicy, type WorkflowRegistry } from "./registry.js";
import type { RunStore } from "./store.js";

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

export interface WorkflowSummary {
  name: string;
  version: number;
  steps: string[];
}

/**
 * Application-level operations around runs. Shared by the HTTP API and tests
 * so both exercise the same code path.
 */
export class WorkflowService {
  constructor(
    private readonly store: RunStore,
    private readonly registry: WorkflowRegistry,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  listWorkflows(): WorkflowSummary[] {
    return this.registry.list().map((workflow) => ({
      name: workflow.name,
      version: workflow.version ?? 1,
      steps: workflow.steps.map((step) => step.name),
    }));
  }

  createRun(
    workflowName: string,
    input: unknown = null,
    idempotencyKey?: string,
  ): CreateRunResult {
    const workflow = this.registry.get(workflowName);
    if (!workflow) throw new NotFoundError(`Unknown workflow "${workflowName}"`);

    const key = normalizeIdempotencyKey(idempotencyKey);
    if (key) {
      const existing = this.store.findRunByIdempotencyKey(key);
      if (existing) return this.replayExisting(existing, workflowName);
    }

    const normalizedInput = normalizeInput(input);
    const runId = randomUUID();
    const version = workflow.version ?? 1;
    const steps = workflow.steps.map((step, index) => ({
      id: randomUUID(),
      index,
      name: step.name,
      idempotencyKey: `${runId}:${index}:${step.name}`,
      retry: resolveRetryPolicy(workflow, step),
    }));

    try {
      const run = this.store.createRun({
        id: runId,
        workflowName,
        workflowVersion: version,
        input: normalizedInput,
        idempotencyKey: key,
        steps,
        now: this.clock.now(),
      });
      return { run, steps: this.store.getSteps(run.id), created: true };
    } catch (error) {
      // Another request may have won the idempotency-key race.
      if (key) {
        const existing = this.store.findRunByIdempotencyKey(key);
        if (existing) return this.replayExisting(existing, workflowName);
      }
      throw error;
    }
  }

  getRun(runId: string): RunDetail {
    const detail = this.store.getRunDetail(runId);
    if (!detail) throw new NotFoundError(`Run "${runId}" not found`);
    return detail;
  }

  listRuns(options: ListRunsOptions): { runs: RunDetail["run"][]; total: number } {
    return this.store.listRuns(options);
  }

  getEvents(runId: string, afterSeq?: number, limit?: number): WorkflowEvent[] {
    if (!this.store.findRunById(runId)) {
      throw new NotFoundError(`Run "${runId}" not found`);
    }
    return this.store.getEvents(runId, afterSeq, limit);
  }

  cancelRun(runId: string): RunDetail {
    const run = this.store.findRunById(runId);
    if (!run) throw new NotFoundError(`Run "${runId}" not found`);
    if (run.status !== "pending" && run.status !== "running") {
      throw new ConflictError(
        `Run "${runId}" cannot be cancelled from status "${run.status}"`,
      );
    }
    const cancelled = this.store.cancelRun(runId, this.clock.now());
    if (!cancelled) {
      throw new ConflictError(`Run "${runId}" could not be cancelled because it already finished`);
    }
    return this.getRun(runId);
  }

  private replayExisting(
    existing: { id: string; workflowName: string },
    requestedWorkflow: string,
  ): CreateRunResult {
    if (existing.workflowName !== requestedWorkflow) {
      throw new ConflictError(
        `Idempotency key already belongs to workflow "${existing.workflowName}", not "${requestedWorkflow}"`,
      );
    }
    const run = this.store.findRunById(existing.id);
    if (!run) throw new Error(`Run ${existing.id} disappeared`);
    return { run, steps: this.store.getSteps(run.id), created: false };
  }
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const key = value.trim();
  if (key.length === 0) throw new ValidationError("idempotencyKey must not be empty");
  if (key.length > 200) throw new ValidationError("idempotencyKey must be at most 200 characters");
  return key;
}

function normalizeInput(input: unknown): unknown {
  const value = input === undefined ? null : input;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new ValidationError("input must be JSON-serializable", String(error));
  }
  if (encoded === undefined) {
    throw new ValidationError("input must be JSON-serializable");
  }
  return JSON.parse(encoded) as unknown;
}
