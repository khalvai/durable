import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { createHarness, drain, orderInput, type Harness } from "./helpers.js";

interface ApiFixture {
  app: FastifyInstance;
  harness: Harness;
}

const fixtures: ApiFixture[] = [];

function fixture(): ApiFixture {
  const harness = createHarness();
  const app = buildApp({ service: harness.service });
  const value = { app, harness };
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const current = fixtures.pop();
    if (!current) continue;
    await current.app.close();
    current.harness.close();
  }
});

describe("HTTP API", () => {
  it("reports health and registered workflows", async () => {
    const { app } = fixture();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok" });

    const workflows = await app.inject({ method: "GET", url: "/api/workflows" });
    expect(workflows.statusCode).toBe(200);
    expect(workflows.json().workflows).toEqual([
      {
        name: "order-processing",
        version: 1,
        steps: ["reserve-inventory", "process-payment", "arrange-shipping"],
      },
    ]);
  });

  it("creates a run, executes it, and exposes steps and events", async () => {
    const { app, harness } = fixture();

    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload: { input: orderInput() },
    });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json();
    expect(createdBody.created).toBe(true);
    expect(createdBody.run.status).toBe("pending");
    expect(createdBody.steps).toHaveLength(3);

    await drain(harness);

    const detail = await app.inject({ method: "GET", url: `/api/runs/${createdBody.run.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.status).toBe("completed");
    expect(detail.json().steps.map((step: { status: string }) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);

    const events = await app.inject({
      method: "GET",
      url: `/api/runs/${createdBody.run.id}/events?after=0`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.json().events.length).toBeGreaterThan(0);
    expect(
      events.json().events.some((event: { type: string }) => event.type === "run.completed"),
    ).toBe(true);
  });

  it("returns the existing run for a repeated idempotency key", async () => {
    const { app } = fixture();
    const payload = {
      input: orderInput(),
      idempotencyKey: "checkout-42",
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().run.id).toBe(first.json().run.id);
  });

  it("validates requests and reports missing resources", async () => {
    const { app } = fixture();

    const unknownWorkflow = await app.inject({
      method: "POST",
      url: "/api/workflows/nope/runs",
      payload: {},
    });
    expect(unknownWorkflow.statusCode).toBe(404);
    expect(unknownWorkflow.json().error.type).toBe("not_found");

    const invalidBody = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload: { idempotencyKey: "" },
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json().error.type).toBe("validation_error");

    const missing = await app.inject({ method: "GET", url: "/api/runs/does-not-exist" });
    expect(missing.statusCode).toBe(404);

    const badStatus = await app.inject({ method: "GET", url: "/api/runs?status=banana" });
    expect(badStatus.statusCode).toBe(400);
  });

  it("lists and filters runs", async () => {
    const { app, harness } = fixture();
    const first = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload: { input: orderInput({ orderId: "a" }) },
    });
    await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload: { input: orderInput({ orderId: "b" }) },
    });

    await drain(harness);

    const all = await app.inject({ method: "GET", url: "/api/runs" });
    expect(all.statusCode).toBe(200);
    expect(all.json().total).toBe(2);

    const completed = await app.inject({ method: "GET", url: "/api/runs?status=completed" });
    expect(completed.json().total).toBe(2);

    const pending = await app.inject({ method: "GET", url: "/api/runs?status=pending" });
    expect(pending.json().total).toBe(0);

    const byWorkflow = await app.inject({
      method: "GET",
      url: "/api/runs?workflow=order-processing&limit=1&offset=0",
    });
    expect(byWorkflow.json().runs).toHaveLength(1);
    expect(byWorkflow.json().total).toBe(2);
    expect(byWorkflow.json().runs[0].id).toBeDefined();
    expect(first.statusCode).toBe(202);
  });

  it("cancels a pending run and rejects cancelling a finished one", async () => {
    const { app, harness } = fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload: { input: orderInput() },
    });
    const runId = created.json().run.id;

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json().run.status).toBe("cancelled");

    const again = await app.inject({ method: "POST", url: `/api/runs/${runId}/cancel` });
    expect(again.statusCode).toBe(409);

    const finished = await app.inject({
      method: "POST",
      url: "/api/workflows/order-processing/runs",
      payload: { input: orderInput() },
    });
    await drain(harness);
    const finishedCancel = await app.inject({
      method: "POST",
      url: `/api/runs/${finished.json().run.id}/cancel`,
    });
    expect(finishedCancel.statusCode).toBe(409);
  });
});
