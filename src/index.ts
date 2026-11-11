import { buildApp } from "./api/server.js";
import { loadConfig } from "./config.js";
import { Database } from "./db/database.js";
import { WorkflowEngine } from "./engine/engine.js";
import { RunStore } from "./engine/store.js";
import { WorkflowService } from "./engine/workflow-service.js";
import { createDemoSetup } from "./workflows/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new Database(config.databasePath);
  const store = new RunStore(database);
  const { registry, services } = createDemoSetup();
  const service = new WorkflowService(store, registry);

  const app = buildApp({ service, logger: { level: config.logLevel } });
  const engine = new WorkflowEngine({
    store,
    registry,
    leaseMs: config.leaseMs,
    concurrency: config.concurrency,
    pollIntervalMs: config.pollIntervalMs,
    defaultStepTimeoutMs: config.defaultStepTimeoutMs,
    logger: app.log,
  });

  if (config.workerEnabled) engine.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutting down");
    await engine.stop();
    await app.close();
    database.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      database: config.databasePath,
      workerEnabled: config.workerEnabled,
      workflows: registry.list().map((workflow) => workflow.name),
      inventoryStock: {
        "sku-1": services.inventory.available("sku-1"),
        "sku-2": services.inventory.available("sku-2"),
      },
    },
    "Durable workflow engine ready",
  );
}

main().catch((error) => {
  console.error("Fatal startup error", error);
  process.exit(1);
});
