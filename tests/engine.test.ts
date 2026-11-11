import { afterEach, describe, expect, it } from "vitest";
import { PermanentError, RetryableError } from "../src/engine/errors.js";
import { createHarness, drain, orderInput, type Harness } from "./helpers.js";

const harnesses: Harness[] = [];

function harness(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close();
});

describe("durability and recovery", () => {
  it("reclaims a step whose worker lease expired", async () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput());

    // Simulate a worker that claims the step and then crashes.
    const crashedTask = h.store.claimNext("crashed-worker", h.clock.now(), 1_000);
    expect(crashedTask?.stepName).toBe("reserve-inventory");

    h.clock.advance(1_001);
    await h.engine.tick();
    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.steps[0]?.attempts).toBe(2);

    const attempts = h.store.getAttempts(detail.steps[0]!.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["lease_expired", "succeeded"]);
    expect(h.service.getEvents(run.id).map((event) => event.type)).toContain(
      "step.lease_expired",
    );
  });

  it("discards a stale result from a worker that lost its lease", async () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput());

    const staleTask = h.store.claimNext("worker-old", h.clock.now(), 1_000);
    expect(staleTask).not.toBeNull();

    h.clock.advance(1_001);
    expect(h.store.recoverExpiredLeases(h.clock.now())).toBe(1);
    const freshTask = h.store.claimNext("worker-new", h.clock.now(), 1_000);
    expect(freshTask?.stepName).toBe("reserve-inventory");

    const fresh = h.store.markStepSucceeded(freshTask!, { reservationId: "fresh" }, h.clock.now());
    expect(fresh.applied).toBe(true);

    const stale = h.store.markStepSucceeded(staleTask!, { reservationId: "stale" }, h.clock.now());
    expect(stale.applied).toBe(false);

    const detail = h.service.getRun(run.id);
    expect(detail.steps[0]?.output).toEqual({ reservationId: "fresh" });

    const attempts = h.store.getAttempts(detail.steps[0]!.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["lease_expired", "succeeded"]);
  });

  it("fails an in-flight step when its run is cancelled", () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput());
    const task = h.store.claimNext("worker-a", h.clock.now(), 1_000);
    expect(task?.stepName).toBe("reserve-inventory");

    const cancelled = h.service.cancelRun(run.id);
    expect(cancelled.run.status).toBe("cancelled");

    h.clock.advance(1_001);
    expect(h.store.recoverExpiredLeases(h.clock.now())).toBe(1);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("cancelled");
    expect(detail.steps[0]?.status).toBe("failed");
    expect(detail.steps[1]?.status).toBe("skipped");
    // Cancellation is not a rollback: no compensation was scheduled.
    expect(h.service.getEvents(run.id).map((event) => event.type)).not.toContain(
      "run.compensating",
    );
  });

  it("fails the run when a lease expires after the final attempt", async () => {
    const h = harness({
      setup: (registry) => {
        registry.register({
          name: "one-shot",
          defaultRetry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
          steps: [{ name: "only-step", execute: async () => "done" }],
        });
      },
    });
    const { run } = h.service.createRun("one-shot", {});

    const task = h.store.claimNext("crashed-worker", h.clock.now(), 1_000);
    expect(task?.stepName).toBe("only-step");

    h.clock.advance(1_001);
    await h.engine.tick();

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("compensated"); // nothing to compensate
    expect(detail.steps[0]?.status).toBe("failed");
    expect(detail.steps[0]?.error).toMatchObject({ code: "LEASE_EXPIRED" });
  });

  it("times out a hung step and retries it", async () => {
    let calls = 0;
    const h = harness({
      setup: (registry) => {
        registry.register({
          name: "hung-step",
          defaultRetry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
          steps: [
            {
              name: "work",
              timeoutMs: 25,
              async execute() {
                calls += 1;
                if (calls === 1) await new Promise(() => {});
                return "ok";
              },
            },
          ],
        });
      },
    });
    const { run } = h.service.createRun("hung-step", {});

    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.steps[0]?.attempts).toBe(2);
    const retryEvent = h.service
      .getEvents(run.id)
      .find((event) => event.type === "step.retry_scheduled");
    expect(retryEvent?.data).toMatchObject({ error: { code: "STEP_TIMEOUT" } });
    expect(calls).toBe(2);
  });

  it("retries an unknown failure but not a PermanentError", async () => {
    let calls = 0;
    const h = harness({
      setup: (registry) => {
        registry.register({
          name: "classification",
          defaultRetry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
          steps: [
            {
              name: "unknown-error",
              async execute() {
                calls += 1;
                if (calls === 1) throw new Error("socket reset");
                return "recovered";
              },
            },
          ],
        });
        registry.register({
          name: "permanent",
          defaultRetry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
          steps: [
            {
              name: "bad-input",
              async execute() {
                throw new PermanentError("nope", { code: "NOPE" });
              },
            },
          ],
        });
      },
    });

    const retried = h.service.createRun("classification", {});
    const permanent = h.service.createRun("permanent", {});

    await drain(h);

    expect(h.service.getRun(retried.run.id).run.status).toBe("completed");
    expect(h.service.getRun(retried.run.id).steps[0]?.attempts).toBe(2);

    const permanentDetail = h.service.getRun(permanent.run.id);
    expect(permanentDetail.run.status).toBe("compensated");
    expect(permanentDetail.steps[0]?.attempts).toBe(1);
    expect(permanentDetail.steps[0]?.error).toMatchObject({ code: "NOPE" });
  });

  it("uses the idempotency key to avoid duplicating side effects after a crash", async () => {
    const effects = new Map<string, number>();
    let calls = 0;
    const h = harness({
      setup: (registry) => {
        registry.register({
          name: "crash-after-write",
          defaultRetry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
          steps: [
            {
              name: "write-effect",
              async execute(ctx) {
                calls += 1;
                if (!effects.has(ctx.idempotencyKey)) {
                  effects.set(ctx.idempotencyKey, calls);
                }
                if (calls === 1) {
                  // Simulates a crash after the downstream write but before
                  // the engine could persist the step result.
                  throw new RetryableError("connection lost after write");
                }
                return { recorded: effects.get(ctx.idempotencyKey) };
              },
            },
          ],
        });
      },
    });

    const { run } = h.service.createRun("crash-after-write", {});
    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.steps[0]?.attempts).toBe(2);
    expect(effects.size).toBe(1);
    expect(calls).toBe(2);
    expect(detail.steps[0]?.output).toEqual({ recorded: 1 });
  });

  it("processes multiple runs concurrently", async () => {
    const h = harness();
    const runs = Array.from({ length: 5 }, (_, index) =>
      h.service.createRun("order-processing", orderInput({ orderId: `order-${index}` })),
    );

    await drain(h);

    for (const { run } of runs) {
      expect(h.service.getRun(run.id).run.status).toBe("completed");
    }
    expect(h.services.payment.chargeCount).toBe(5);
    expect(h.services.shipping.shipmentCount).toBe(5);
  });
});
