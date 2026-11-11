import type { Clock } from "../src/domain/types.js";
import { Database } from "../src/db/database.js";
import { WorkflowEngine } from "../src/engine/engine.js";
import { WorkflowRegistry } from "../src/engine/registry.js";
import { RunStore } from "../src/engine/store.js";
import { WorkflowService } from "../src/engine/workflow-service.js";
import { createDemoSetup, type OrderServices } from "../src/workflows/index.js";

export class FakeClock implements Clock {
  constructor(private current: number = 1_700_000_000_000) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

export interface HarnessOptions {
  databasePath?: string;
  clock?: FakeClock;
  leaseMs?: number;
  setup?: (registry: WorkflowRegistry) => void;
}

export interface Harness {
  database: Database;
  store: RunStore;
  registry: WorkflowRegistry;
  services: OrderServices;
  service: WorkflowService;
  engine: WorkflowEngine;
  clock: FakeClock;
  close(): void;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? new FakeClock();
  const database = new Database(options.databasePath ?? ":memory:");
  const store = new RunStore(database);
  const { registry, services } = createDemoSetup();
  options.setup?.(registry);
  const service = new WorkflowService(store, registry, clock);
  const engine = new WorkflowEngine({
    store,
    registry,
    clock,
    workerId: "worker-a",
    leaseMs: options.leaseMs ?? 1_000,
    concurrency: 8,
    pollIntervalMs: 10,
    defaultStepTimeoutMs: 5_000,
  });
  return {
    database,
    store,
    registry,
    services,
    service,
    engine,
    clock,
    close: () => database.close(),
  };
}

/**
 * Runs the engine until no step is due, advancing the fake clock to the next
 * scheduled retry whenever the engine goes idle.
 */
export async function drain(harness: Harness, maxRounds = 200): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    await harness.engine.runUntilIdle();
    const next = harness.store.nextRunnableAt();
    if (next === null) return;
    if (next <= harness.clock.now()) {
      throw new Error(
        `Engine is idle but a runnable step is already due at ${next} (now ${harness.clock.now()})`,
      );
    }
    harness.clock.set(next);
  }
  throw new Error(`Workflow did not settle after ${maxRounds} rounds`);
}

export function orderInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: "order-1",
    customerId: "customer-1",
    items: [{ sku: "sku-1", quantity: 3 }],
    amount: 199.99,
    ...overrides,
  };
}
