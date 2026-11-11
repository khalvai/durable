import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,
  workflow_name      TEXT NOT NULL,
  workflow_version   INTEGER NOT NULL,
  status             TEXT NOT NULL,
  input_json         TEXT NOT NULL,
  output_json        TEXT,
  error_json         TEXT,
  idempotency_key    TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  finished_at        INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_key
  ON runs(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS runs_workflow ON runs(workflow_name);
CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at);

CREATE TABLE IF NOT EXISTS steps (
  id                      TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_index              INTEGER NOT NULL,
  name                    TEXT NOT NULL,
  status                  TEXT NOT NULL,
  attempts                INTEGER NOT NULL DEFAULT 0,
  max_attempts            INTEGER NOT NULL,
  compensation_attempts   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at         INTEGER NOT NULL,
  lease_owner             TEXT,
  lease_expires_at        INTEGER,
  idempotency_key         TEXT NOT NULL,
  retry_json              TEXT NOT NULL,
  output_json             TEXT,
  error_json              TEXT,
  started_at              INTEGER,
  finished_at             INTEGER,
  UNIQUE(run_id, step_index)
);

CREATE INDEX IF NOT EXISTS steps_run ON steps(run_id, step_index);
CREATE INDEX IF NOT EXISTS steps_claim ON steps(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS steps_lease ON steps(lease_expires_at);

CREATE TABLE IF NOT EXISTS attempts (
  id              TEXT PRIMARY KEY,
  step_id         TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  attempt_number  INTEGER NOT NULL,
  worker_id       TEXT NOT NULL,
  status          TEXT NOT NULL,
  error_json      TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  UNIQUE(step_id, kind, attempt_number)
);

CREATE INDEX IF NOT EXISTS attempts_step ON attempts(step_id);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     TEXT,
  type        TEXT NOT NULL,
  data_json   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
`;

export class Database {
  readonly handle: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") {
      const absolute = resolve(path);
      mkdirSync(dirname(absolute), { recursive: true });
      this.handle = new DatabaseSync(absolute, { enableForeignKeyConstraints: true });
      this.handle.exec("PRAGMA journal_mode = WAL");
      this.handle.exec("PRAGMA synchronous = NORMAL");
    } else {
      this.handle = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    }
    this.handle.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    const row = this.handle.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const version = row?.user_version ?? 0;
    if (version < SCHEMA_VERSION) {
      this.handle.exec("BEGIN IMMEDIATE");
      try {
        this.handle.exec(SCHEMA);
        this.handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        this.handle.exec("COMMIT");
      } catch (error) {
        this.handle.exec("ROLLBACK");
        throw error;
      }
    }
  }

  /**
   * Runs `fn` inside an immediate transaction. `BEGIN IMMEDIATE` acquires the
   * write lock up front, which keeps concurrent workers from interleaving
   * claims.
   */
  transaction<T>(fn: () => T): T {
    this.handle.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.handle.exec("COMMIT");
      return result;
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.handle.close();
  }
}

/** node:sqlite reports `changes` as number | bigint depending on the build. */
export function changesOf(result: { changes: number | bigint }): number {
  return Number(result.changes);
}
