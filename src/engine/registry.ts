import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type StepDefinition,
  type WorkflowDefinition,
} from "../domain/types.js";

/**
 * Holds the workflow definitions a worker can execute. Definitions are
 * registered by name at boot time.
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition): void {
    if (!definition.name || definition.name.trim().length === 0) {
      throw new Error("Workflow name must not be empty");
    }
    if (this.workflows.has(definition.name)) {
      throw new Error(`Workflow "${definition.name}" is already registered`);
    }
    if (definition.steps.length === 0) {
      throw new Error(`Workflow "${definition.name}" must have at least one step`);
    }
    const names = new Set<string>();
    for (const step of definition.steps) {
      if (!step.name) throw new Error(`Workflow "${definition.name}" has a step without a name`);
      if (names.has(step.name)) {
        throw new Error(`Workflow "${definition.name}" has duplicate step "${step.name}"`);
      }
      names.add(step.name);
      resolveRetryPolicy(definition, step);
    }
    this.workflows.set(definition.name, definition);
  }

  get(name: string): WorkflowDefinition | undefined {
    return this.workflows.get(name);
  }

  has(name: string): boolean {
    return this.workflows.has(name);
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }
}

export function resolveRetryPolicy(
  workflow: WorkflowDefinition,
  step: StepDefinition,
): RetryPolicy {
  const policy: RetryPolicy = {
    ...DEFAULT_RETRY_POLICY,
    ...workflow.defaultRetry,
    ...step.retry,
  };
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error(`Step "${step.name}" has an invalid maxAttempts (${policy.maxAttempts})`);
  }
  if (policy.initialDelayMs < 0 || policy.maxDelayMs < 0) {
    throw new Error(`Step "${step.name}" has a negative retry delay`);
  }
  if (policy.backoffFactor < 1) {
    throw new Error(`Step "${step.name}" has a backoffFactor below 1`);
  }
  return policy;
}

/**
 * Exponential backoff after `failedAttempt` (1-based). The first retry waits
 * `initialDelayMs`, the second `initialDelayMs * backoffFactor`, and so on,
 * capped at `maxDelayMs`.
 */
export function computeBackoffDelay(policy: RetryPolicy, failedAttempt: number): number {
  const exponent = Math.max(failedAttempt - 1, 0);
  const delay = policy.initialDelayMs * Math.pow(policy.backoffFactor, exponent);
  return Math.min(Math.round(delay), policy.maxDelayMs);
}
