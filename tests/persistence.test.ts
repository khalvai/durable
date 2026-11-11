import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, createHarness, drain, orderInput, type Harness } from "./helpers.js";

const directories: string[] = [];
const openHarnesses: Harness[] = [];

function tempDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "durable-engine-"));
  directories.push(directory);
  return join(directory, "workflows.db");
}

function open(path: string, clock: FakeClock): Harness {
  const harness = createHarness({ databasePath: path, clock, leaseMs: 1_000 });
  openHarnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (openHarnesses.length > 0) {
    try {
      openHarnesses.pop()?.close();
    } catch {
      // already closed by the test
    }
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { recursive: true, force: true });
  }
});

describe("persistence across process restarts", () => {
  it("keeps a completed run and its history on disk", async () => {
    const path = tempDatabase();
    const clock = new FakeClock();
    const first = open(path, clock);
    const { run } = first.service.createRun("order-processing", orderInput());
    await drain(first);
    const completed = first.service.getRun(run.id);
    expect(completed.run.status).toBe("completed");
    first.close();
    openHarnesses.splice(openHarnesses.indexOf(first), 1);

    const second = open(path, clock);
    const reloaded = second.service.getRun(run.id);
    expect(reloaded.run.status).toBe("completed");
    expect(reloaded.run.output).toEqual(completed.run.output);
    expect(reloaded.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(second.service.getEvents(run.id).map((event) => event.type)).toContain(
      "run.completed",
    );
  });

  it("resumes an in-flight run after a crash", async () => {
    const path = tempDatabase();
    const clock = new FakeClock();
    const first = open(path, clock);
    const { run } = first.service.createRun("order-processing", orderInput());

    // A worker claims the first step, then the process dies before finishing.
    const crashed = first.store.claimNext("crashed-worker", clock.now(), 1_000);
    expect(crashed?.stepName).toBe("reserve-inventory");
    first.close();
    openHarnesses.splice(openHarnesses.indexOf(first), 1);

    clock.advance(1_001);
    const second = open(path, clock);
    await drain(second);

    const detail = second.service.getRun(run.id);
    expect(detail.run.status).toBe("completed");
    expect(detail.steps[0]?.attempts).toBe(2);
    const attempts = second.store.getAttempts(detail.steps[0]!.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["lease_expired", "succeeded"]);
    expect(second.service.getEvents(run.id).map((event) => event.type)).toContain(
      "step.lease_expired",
    );
  });
});
