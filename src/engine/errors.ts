import type { SerializedError } from "../domain/types.js";

/**
 * Throw this from a step when the failure may succeed on a later attempt
 * (timeouts, 5xx responses, lock contention, ...).
 */
export class RetryableError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: { code?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "RetryableError";
    this.code = options.code;
    this.details = options.details;
  }
}

/**
 * Throw this from a step when retrying cannot help (validation errors, missing
 * resources, business rule violations, ...). The engine moves straight to
 * compensation.
 */
export class PermanentError extends Error {
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: { code?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "PermanentError";
    this.code = options.code;
    this.details = options.details;
  }
}

/** Raised internally when a step exceeds its configured timeout. */
export class StepTimeoutError extends RetryableError {
  constructor(stepName: string, timeoutMs: number) {
    super(`Step "${stepName}" timed out after ${timeoutMs}ms`, { code: "STEP_TIMEOUT" });
    this.name = "StepTimeoutError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ValidationError extends Error {
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof PermanentError) return false;
  if (error instanceof RetryableError) return true;
  // Unknown errors are assumed to be transient. Use PermanentError for
  // failures that must not be retried.
  return true;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const serialized: SerializedError = {
      name: error.name,
      message: error.message,
    };
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") serialized.code = code;
    const details = (error as { details?: unknown }).details;
    if (details !== undefined) serialized.details = details;
    return serialized;
  }
  return { name: "Error", message: String(error) };
}
