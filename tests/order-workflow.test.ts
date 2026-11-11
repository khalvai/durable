import { afterEach, describe, expect, it } from "vitest";
import { createHarness, drain, orderInput, type Harness } from "./helpers.js";

const harnesses: Harness[] = [];

function harness(): Harness {
  const created = createHarness();
  harnesses.push(created);
  return created;
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.close();
});

describe("order-processing workflow", () => {
  it("completes all steps and records outputs", async () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput());

    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(detail.steps.map((step) => step.attempts)).toEqual([1, 1, 1]);
    expect(detail.run.output).toEqual({
      shipmentId: "shp_1",
      trackingNumber: "TRK-000001",
    });
    expect(detail.run.error).toBeNull();

    expect(h.services.inventory.available("sku-1")).toBe(97);
    expect(h.services.inventory.reservationCount).toBe(1);
    expect(h.services.payment.chargeCount).toBe(1);
    expect(h.services.payment.totalCharged()).toBe(199.99);
    expect(h.services.shipping.shipmentCount).toBe(1);

    const events = h.service.getEvents(run.id).map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining([
        "run.created",
        "run.started",
        "step.started",
        "step.succeeded",
        "run.completed",
      ]),
    );
  });

  it("retries a transient failure and does not double-charge", async () => {
    const h = harness();
    const { run } = h.service.createRun(
      "order-processing",
      orderInput({ faults: { "process-payment": { failTimes: 1 } } }),
    );

    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.steps[1]?.attempts).toBe(2);
    expect(h.services.payment.chargeCount).toBe(1);
    expect(h.services.payment.totalCharged()).toBe(199.99);

    const retryEvents = h.service
      .getEvents(run.id)
      .filter((event) => event.type === "step.retry_scheduled");
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.data).toMatchObject({ attempt: 1 });
  });

  it("retries until attempts are exhausted, then compensates completed steps", async () => {
    const h = harness();
    const { run } = h.service.createRun(
      "order-processing",
      orderInput({ faults: { "process-payment": { failTimes: 99 } } }),
    );

    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("compensated");
    expect(detail.steps.map((step) => step.status)).toEqual([
      "compensated",
      "failed",
      "skipped",
    ]);
    expect(detail.steps[1]?.attempts).toBe(4);
    expect(detail.steps[1]?.error).toMatchObject({ code: "INJECTED_FAULT" });
    expect(detail.run.error).toMatchObject({ code: "INJECTED_FAULT" });

    // Payment never succeeded, so only the inventory reservation is undone.
    expect(h.services.payment.chargeCount).toBe(0);
    expect(h.services.payment.refundCount).toBe(0);
    expect(h.services.inventory.releaseCount).toBe(1);
    expect(h.services.inventory.available("sku-1")).toBe(100);

    const retryEvents = h.service
      .getEvents(run.id)
      .filter((event) => event.type === "step.retry_scheduled");
    expect(retryEvents).toHaveLength(3);
  });

  it("compensates in reverse order when shipping fails permanently", async () => {
    const h = harness();
    const { run } = h.service.createRun(
      "order-processing",
      orderInput({ faults: { "arrange-shipping": { permanent: true } } }),
    );

    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("compensated");
    expect(detail.steps.map((step) => step.status)).toEqual([
      "compensated",
      "compensated",
      "failed",
    ]);
    expect(detail.steps[2]?.attempts).toBe(1); // permanent: no retries

    expect(h.services.payment.refundCount).toBe(1);
    expect(h.services.inventory.releaseCount).toBe(1);
    expect(h.services.inventory.available("sku-1")).toBe(100);
    expect(h.services.shipping.cancellationCount).toBe(0);

    const compensatedStepIds = h.service
      .getEvents(run.id)
      .filter((event) => event.type === "step.compensated")
      .map((event) => event.stepId);
    expect(compensatedStepIds).toEqual([detail.steps[1]?.id, detail.steps[0]?.id]);
  });

  it("does not retry a PermanentError", async () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput({ amount: -1 }));

    await drain(h);

    const detail = h.service.getRun(run.id);
    expect(detail.run.status).toBe("compensated");
    expect(detail.steps[1]?.attempts).toBe(1);
    expect(detail.steps[1]?.error).toMatchObject({ code: "INVALID_AMOUNT" });
    expect(h.services.inventory.releaseCount).toBe(1);
  });

  it("replays an idempotency key instead of creating a second run", () => {
    const h = harness();
    const first = h.service.createRun("order-processing", orderInput(), "checkout-123");
    const second = h.service.createRun("order-processing", orderInput(), "checkout-123");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    const list = h.service.listRuns({});
    expect(list.total).toBe(1);
  });

  it("rejects reusing an idempotency key for a different workflow", () => {
    const h = harness();
    h.registry.register({
      name: "other-workflow",
      steps: [{ name: "noop", execute: async () => null }],
    });
    h.service.createRun("order-processing", orderInput(), "shared-key");

    expect(() => h.service.createRun("other-workflow", {}, "shared-key")).toThrow(
      /already belongs to workflow/,
    );
  });

  it("cancels a pending run and skips its steps", async () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput());

    const cancelled = h.service.cancelRun(run.id);
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.steps.map((step) => step.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
    ]);

    await drain(h);
    expect(h.service.getRun(run.id).run.status).toBe("cancelled");
    expect(h.services.payment.chargeCount).toBe(0);
  });

  it("refuses to cancel a finished run", async () => {
    const h = harness();
    const { run } = h.service.createRun("order-processing", orderInput());
    await drain(h);

    expect(() => h.service.cancelRun(run.id)).toThrow(/cannot be cancelled/);
  });
});
