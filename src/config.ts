export interface Config {
  host: string;
  port: number;
  databasePath: string;
  workerEnabled: boolean;
  pollIntervalMs: number;
  leaseMs: number;
  concurrency: number;
  defaultStepTimeoutMs: number;
  logLevel: string;
}

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.HOST ?? "0.0.0.0",
    port: intFromEnv("PORT", 3000, env),
    databasePath: env.DATABASE_PATH ?? "./data/durable.db",
    workerEnabled: env.WORKER_ENABLED !== "false",
    pollIntervalMs: intFromEnv("POLL_INTERVAL_MS", 100, env),
    leaseMs: intFromEnv("LEASE_MS", 30_000, env),
    concurrency: intFromEnv("CONCURRENCY", 4, env),
    defaultStepTimeoutMs: intFromEnv("STEP_TIMEOUT_MS", 30_000, env),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
