// Workboard plugin module implements sqlite store behavior.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { configureSqliteConnectionPragmas } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import type {
  WorkboardArtifact,
  WorkboardAttachment,
  WorkboardCard,
  WorkboardComment,
  WorkboardDiagnostic,
  WorkboardEvent,
  WorkboardExecution,
  WorkboardLink,
  WorkboardMetadata,
  WorkboardNotification,
  WorkboardProof,
  WorkboardRunAttempt,
  WorkboardWorkerLog,
} from "./types.js";

const WORKBOARD_DB_RELATIVE_PATH = ["plugins", "workboard", "workboard.sqlite"] as const;
// Schema 3 = additive AUT-WB-ATOMIC correlation authority (contract aut-wb-atomic/1 §6.1).
// The base DDL below still records `schema-2`; the atomic migration transactionally adds
// `schema-3` + `schema-3-aut-wb-atomic` so an interrupted migration is all-or-nothing.
const SCHEMA_VERSION = 3;
const BASE_SCHEMA_MIGRATION_ID = "schema-2";
const ATOMIC_SCHEMA_MIGRATION_IDS = [`schema-${SCHEMA_VERSION}`, "schema-3-aut-wb-atomic"] as const;
const ATOMIC_AUTHORITY_COLUMNS = [
  "correlation_key",
  "governance_spec_version",
  "governance_spec_json",
  "governance_fingerprint",
] as const;
const ATOMIC_CORRELATION_INDEX = "workboard_cards_correlation_key_uq";
const ATOMIC_RECEIPTS_TABLE = "workboard_atomic_create_receipts";
const ATOMIC_TRIGGERS = [
  "workboard_cards_atomic_tuple_complete_insert",
  "workboard_cards_atomic_tuple_complete_update",
  "workboard_cards_atomic_tuple_immutable",
  "workboard_cards_correlated_no_delete",
  "workboard_atomic_create_receipts_no_update",
  "workboard_atomic_create_receipts_no_delete",
] as const;
// Receipts are written only for the six store-durable outcomes (contract §4.3); the
// CHECK constraints below enforce that plus the frozen outcome/reason pairing.
const ATOMIC_RECEIPT_REASON_OUTCOME_PAIRS = [
  ["workboard_card_created", "created"],
  ["workboard_card_recovered", "recovered"],
  ["workboard_card_conflict", "refused"],
  ["workboard_stored_record_invalid", "refused"],
  ["workboard_card_state_incompatible", "refused"],
  ["workboard_incompatible_legacy_card", "refused"],
] as const;
const WORKBOARD_SQLITE_BUSY_TIMEOUT_MS = 5000;
const WORKBOARD_SQLITE_DIR_MODE = 0o700;
const WORKBOARD_SQLITE_FILE_MODE = 0o600;

type Row = Record<string, unknown>;

type WorkboardSqliteStores = {
  cards: WorkboardKeyedStore;
  boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
  subscriptions: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
  attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
  close: () => void;
};

export function resolveWorkboardSqlitePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), ...WORKBOARD_DB_RELATIVE_PATH);
}

function jsonValue(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return JSON.parse(value) as unknown;
}

function stringValue(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(row: Row, key: string): number | undefined {
  const value = row[key];
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return undefined;
}

function requiredString(row: Row, key: string): string {
  const value = stringValue(row, key);
  if (!value) {
    throw new Error(`workboard sqlite row missing ${key}`);
  }
  return value;
}

function requiredNumber(row: Row, key: string): number {
  const value = numberValue(row, key);
  if (value === undefined) {
    throw new Error(`workboard sqlite row missing ${key}`);
  }
  return value;
}

function optional<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

function asBlobContent(value: string): Uint8Array {
  return Buffer.from(value, "base64");
}

function blobToBase64(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (typeof value === "string") {
    return Buffer.from(value).toString("base64");
  }
  return "";
}

function runTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableColumns(db: DatabaseSync, tableName: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Row[]).flatMap((row) =>
      typeof row.name === "string" ? [row.name] : [],
    ),
  );
}

function ensureColumn(db: DatabaseSync, tableName: string, columnName: string, definition: string) {
  if (tableColumns(db, tableName).has(columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
}

function ensureWorkboardSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS workboard_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workboard_boards (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      icon TEXT,
      color TEXT,
      default_workspace_json TEXT,
      orchestration_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workboard_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      agent_id TEXT,
      session_key TEXT,
      run_id TEXT,
      task_id TEXT,
      source_url TEXT,
      position REAL NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      execution_id TEXT,
      execution_kind TEXT,
      execution_engine TEXT,
      execution_mode TEXT,
      execution_status TEXT,
      execution_model TEXT,
      execution_session_key TEXT,
      execution_run_id TEXT,
      execution_started_at INTEGER,
      execution_updated_at INTEGER,
      automation_json TEXT,
      claim_json TEXT,
      template_id TEXT,
      archived_at INTEGER,
      stale_json TEXT,
      lifecycle_status_source_updated_at INTEGER,
      failure_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS workboard_cards_board_status_idx
      ON workboard_cards(board_id, status, position);
    CREATE INDEX IF NOT EXISTS workboard_cards_session_idx
      ON workboard_cards(session_key, run_id);

    CREATE TABLE IF NOT EXISTS workboard_card_labels (
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      label TEXT NOT NULL,
      PRIMARY KEY(card_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS workboard_card_events (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT,
      session_key TEXT,
      run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS workboard_card_attempts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      engine TEXT,
      mode TEXT,
      model TEXT,
      session_key TEXT,
      run_id TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS workboard_card_comments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workboard_card_links (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      type TEXT NOT NULL,
      target_card_id TEXT,
      title TEXT,
      url TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workboard_card_proof (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      label TEXT,
      command TEXT,
      url TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workboard_card_artifacts (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      label TEXT,
      url TEXT,
      path TEXT,
      mime_type TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workboard_card_diagnostics (
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      count INTEGER NOT NULL,
      actions_json TEXT NOT NULL,
      PRIMARY KEY(card_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS workboard_card_notifications (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sequence INTEGER,
      session_key TEXT,
      run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS workboard_worker_logs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      session_key TEXT,
      run_id TEXT
    );

    CREATE TABLE IF NOT EXISTS workboard_worker_protocol (
      card_id TEXT PRIMARY KEY REFERENCES workboard_cards(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS workboard_card_attachments (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES workboard_cards(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      mime_type TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS workboard_card_attachments_card_idx
      ON workboard_card_attachments(card_id, ordinal);

    CREATE TABLE IF NOT EXISTS workboard_attachment_blobs (
      attachment_id TEXT PRIMARY KEY,
      content BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workboard_notification_subscriptions (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      card_id TEXT,
      session_key TEXT,
      run_id TEXT,
      target TEXT,
      event_kinds_json TEXT,
      last_event_at INTEGER,
      last_event_id TEXT,
      last_event_sequence INTEGER,
      delivered_event_ids_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  ensureColumn(
    db,
    "workboard_cards",
    "lifecycle_status_source_updated_at",
    "lifecycle_status_source_updated_at INTEGER",
  );
  db.prepare(
    "INSERT OR IGNORE INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
  ).run(BASE_SCHEMA_MIGRATION_ID, Date.now());
  ensureWorkboardAtomicSchema(db);
}

// Deterministic kill points required by contract row A34 (migration interruption) and
// A05/A06 (crash before/after commit). Inert unless the test-only env var is set.
function atomicTestCrashPoint(stage: string): void {
  if (process.env.OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH === stage) {
    process.kill(process.pid, "SIGKILL");
  }
}

// Deterministic write-stage failure required by contract row A33 (confirmed storage
// failure with full rollback). Inert unless the test-only env var is set.
function atomicTestFaultPoint(stage: string): void {
  if (process.env.OPENCLAW_WORKBOARD_TEST_ATOMIC_FAULT === stage) {
    throw new Error(`workboard atomic test fault injected: ${stage}`);
  }
}

function sqliteMasterNames(db: DatabaseSync, type: string): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Row[]).flatMap(
      (row) => (typeof row.name === "string" ? [row.name] : []),
    ),
  );
}

type WorkboardAtomicSchemaState = {
  ledgerComplete: boolean;
  ledgerPresent: boolean;
  objectsComplete: boolean;
  objectsPresent: boolean;
};

function workboardAtomicSchemaState(db: DatabaseSync): WorkboardAtomicSchemaState {
  const ledgerRows = db
    .prepare("SELECT id FROM workboard_schema_migrations WHERE id IN (?, ?)")
    .all(...ATOMIC_SCHEMA_MIGRATION_IDS) as Row[];
  const ledgerIds = new Set(ledgerRows.map((row) => row.id));
  const columns = tableColumns(db, "workboard_cards");
  const tables = sqliteMasterNames(db, "table");
  const indexes = sqliteMasterNames(db, "index");
  const triggers = sqliteMasterNames(db, "trigger");
  const objectFlags = [
    ...ATOMIC_AUTHORITY_COLUMNS.map((column) => columns.has(column)),
    tables.has(ATOMIC_RECEIPTS_TABLE),
    indexes.has(ATOMIC_CORRELATION_INDEX),
    ...ATOMIC_TRIGGERS.map((trigger) => triggers.has(trigger)),
  ];
  return {
    ledgerComplete: ATOMIC_SCHEMA_MIGRATION_IDS.every((id) => ledgerIds.has(id)),
    ledgerPresent: ledgerIds.size > 0,
    objectsComplete: objectFlags.every(Boolean),
    objectsPresent: objectFlags.some(Boolean),
  };
}

export function workboardAtomicSchemaComplete(db: DatabaseSync): boolean {
  const state = workboardAtomicSchemaState(db);
  return state.ledgerComplete && state.objectsComplete;
}

function atomicMigrationDdl(): string {
  const reasonCodes = ATOMIC_RECEIPT_REASON_OUTCOME_PAIRS.map(([reason]) => `'${reason}'`).join(
    ", ",
  );
  const reasonOutcomePairs = ATOMIC_RECEIPT_REASON_OUTCOME_PAIRS.map(
    ([reason, outcome]) => `(reason_code = '${reason}' AND outcome = '${outcome}')`,
  ).join("\n        OR ");
  return `
    ALTER TABLE workboard_cards ADD COLUMN correlation_key TEXT;
    ALTER TABLE workboard_cards ADD COLUMN governance_spec_version INTEGER;
    ALTER TABLE workboard_cards ADD COLUMN governance_spec_json TEXT;
    ALTER TABLE workboard_cards ADD COLUMN governance_fingerprint TEXT;

    CREATE TRIGGER workboard_cards_atomic_tuple_complete_insert
    BEFORE INSERT ON workboard_cards
    WHEN NOT (
      (
        NEW.correlation_key IS NULL
        AND NEW.governance_spec_version IS NULL
        AND NEW.governance_spec_json IS NULL
        AND NEW.governance_fingerprint IS NULL
      )
      OR
      (
        NEW.correlation_key IS NOT NULL
        AND NEW.governance_spec_version IS NOT NULL
        AND NEW.governance_spec_json IS NOT NULL
        AND NEW.governance_fingerprint IS NOT NULL
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'atomic governance tuple must be complete');
    END;

    CREATE TRIGGER workboard_cards_atomic_tuple_complete_update
    BEFORE UPDATE ON workboard_cards
    WHEN NOT (
      (
        NEW.correlation_key IS NULL
        AND NEW.governance_spec_version IS NULL
        AND NEW.governance_spec_json IS NULL
        AND NEW.governance_fingerprint IS NULL
      )
      OR
      (
        NEW.correlation_key IS NOT NULL
        AND NEW.governance_spec_version IS NOT NULL
        AND NEW.governance_spec_json IS NOT NULL
        AND NEW.governance_fingerprint IS NOT NULL
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'atomic governance tuple must be complete');
    END;

    CREATE TRIGGER workboard_cards_atomic_tuple_immutable
    BEFORE UPDATE ON workboard_cards
    WHEN OLD.correlation_key IS NOT NULL AND (
      NEW.correlation_key IS NOT OLD.correlation_key
      OR NEW.governance_spec_version IS NOT OLD.governance_spec_version
      OR NEW.governance_spec_json IS NOT OLD.governance_spec_json
      OR NEW.governance_fingerprint IS NOT OLD.governance_fingerprint
    )
    BEGIN
      SELECT RAISE(ABORT, 'atomic governance tuple is immutable');
    END;

    CREATE TRIGGER workboard_cards_correlated_no_delete
    BEFORE DELETE ON workboard_cards
    WHEN OLD.correlation_key IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'correlated cards cannot be physically deleted');
    END;

    CREATE TABLE workboard_atomic_create_receipts (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      correlation_key TEXT NOT NULL
        CHECK (length(correlation_key) = 39 AND substr(correlation_key, 1, 7) = 'occ_v1_'),
      card_id TEXT CHECK (card_id IS NULL OR length(card_id) = 36),
      request_fingerprint TEXT NOT NULL
        CHECK (length(request_fingerprint) = 71 AND substr(request_fingerprint, 1, 7) = 'sha256:'),
      stored_fingerprint TEXT CHECK (
        stored_fingerprint IS NULL
        OR (length(stored_fingerprint) = 71 AND substr(stored_fingerprint, 1, 7) = 'sha256:')
      ),
      outcome TEXT NOT NULL,
      reason_code TEXT NOT NULL CHECK (reason_code IN (${reasonCodes})),
      detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 64),
      created_at INTEGER NOT NULL CHECK (created_at > 0),
      CHECK (
        ${reasonOutcomePairs}
      )
    );

    CREATE TRIGGER workboard_atomic_create_receipts_no_update
    BEFORE UPDATE ON workboard_atomic_create_receipts
    BEGIN SELECT RAISE(ABORT, 'workboard atomic receipts are append-only'); END;

    CREATE TRIGGER workboard_atomic_create_receipts_no_delete
    BEFORE DELETE ON workboard_atomic_create_receipts
    BEGIN SELECT RAISE(ABORT, 'workboard atomic receipts are append-only'); END;
  `;
}

// Contract §6.2: one transaction covering DDL, legacy scan, unique index, and ledger.
// Returns true when schema 3 is complete afterwards. Never throws for migration
// failure: legacy schema-2 surfaces must keep working (§6.3) and the atomic method
// then refuses with workboard_atomic_migration_required.
function ensureWorkboardAtomicSchema(db: DatabaseSync): boolean {
  const state = workboardAtomicSchemaState(db);
  if (state.ledgerComplete && state.objectsComplete) {
    return true;
  }
  if (state.ledgerPresent || state.objectsPresent) {
    // Partial/tampered state cannot arise from this transactional migration; do not
    // guess a repair. Atomic calls refuse until an operator restores a clean state.
    return false;
  }
  const baseRow = db
    .prepare("SELECT id FROM workboard_schema_migrations WHERE id = ?")
    .get(BASE_SCHEMA_MIGRATION_ID);
  if (!baseRow) {
    return false;
  }
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return false;
  }
  try {
    db.exec(atomicMigrationDdl());
    atomicTestCrashPoint("migration-ddl");
    // Legacy scan (§6.2 step 7): every legacy automation payload must be readable so
    // call-time legacy detection stays deterministic. Nothing is adopted or backfilled
    // (operator decision 3); unreadable metadata aborts the migration.
    const legacyRows = db
      .prepare("SELECT id, automation_json FROM workboard_cards WHERE automation_json IS NOT NULL")
      .all() as Row[];
    for (const row of legacyRows) {
      JSON.parse(String(row.automation_json));
    }
    db.exec(`
      CREATE UNIQUE INDEX ${ATOMIC_CORRELATION_INDEX}
      ON workboard_cards(correlation_key)
      WHERE correlation_key IS NOT NULL;
    `);
    atomicTestCrashPoint("migration-index");
    const insertLedger = db.prepare(
      "INSERT INTO workboard_schema_migrations (id, applied_at) VALUES (?, ?)",
    );
    for (const id of ATOMIC_SCHEMA_MIGRATION_IDS) {
      insertLedger.run(id, Date.now());
    }
    atomicTestCrashPoint("migration-ledger");
    db.exec("COMMIT");
    atomicTestCrashPoint("migration-post-commit");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      return false;
    }
    return false;
  }
  return workboardAtomicSchemaComplete(db);
}

function chmodIfExists(targetPath: string, mode: number): void {
  try {
    fs.chmodSync(targetPath, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function hardenWorkboardDatabaseFiles(dbPath: string): void {
  fs.chmodSync(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  chmodIfExists(dbPath, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-wal`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-shm`, WORKBOARD_SQLITE_FILE_MODE);
  chmodIfExists(`${dbPath}-journal`, WORKBOARD_SQLITE_FILE_MODE);
}

function createDatabase(dbPath: string): {
  db: DatabaseSync;
  maintenance: ReturnType<typeof configureSqliteConnectionPragmas>;
} {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: WORKBOARD_SQLITE_DIR_MODE });
  chmodIfExists(path.dirname(dbPath), WORKBOARD_SQLITE_DIR_MODE);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", WORKBOARD_SQLITE_FILE_MODE));
  }
  const db = new DatabaseSync(dbPath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: WORKBOARD_SQLITE_BUSY_TIMEOUT_MS,
      checkpointIntervalMs: 0,
      databaseLabel: "workboard database",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    ensureWorkboardSchema(db);
    hardenWorkboardDatabaseFiles(dbPath);
    return { db, maintenance };
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}

function childRows(db: DatabaseSync, table: string, cardId: string): Row[] {
  return db
    .prepare(`SELECT * FROM ${table} WHERE card_id = ? ORDER BY ordinal ASC`)
    .all(cardId) as Row[];
}

function readLabels(db: DatabaseSync, cardId: string): string[] {
  return childRows(db, "workboard_card_labels", cardId).flatMap((row) => {
    const label = stringValue(row, "label");
    return label ? [label] : [];
  });
}

function readEvents(db: DatabaseSync, cardId: string): WorkboardEvent[] | undefined {
  const events = childRows(db, "workboard_card_events", cardId).map((row) => {
    const event: WorkboardEvent = {
      id: requiredString(row, "id"),
      kind: requiredString(row, "kind") as WorkboardEvent["kind"],
      at: requiredNumber(row, "at"),
    };
    const fromStatus = stringValue(row, "from_status");
    const toStatus = stringValue(row, "to_status");
    const sessionKey = stringValue(row, "session_key");
    const runId = stringValue(row, "run_id");
    if (fromStatus) {
      event.fromStatus = fromStatus as WorkboardEvent["fromStatus"];
    }
    if (toStatus) {
      event.toStatus = toStatus as WorkboardEvent["toStatus"];
    }
    if (sessionKey) {
      event.sessionKey = sessionKey;
    }
    if (runId) {
      event.runId = runId;
    }
    return event;
  });
  return events.length > 0 ? events : undefined;
}

function readExecution(row: Row): WorkboardExecution | undefined {
  const id = stringValue(row, "execution_id");
  if (!id) {
    return undefined;
  }
  return {
    id,
    kind: "agent-session",
    engine: requiredString(row, "execution_engine") as WorkboardExecution["engine"],
    mode: requiredString(row, "execution_mode") as WorkboardExecution["mode"],
    status: requiredString(row, "execution_status") as WorkboardExecution["status"],
    model: requiredString(row, "execution_model"),
    ...(stringValue(row, "execution_session_key")
      ? { sessionKey: stringValue(row, "execution_session_key") }
      : {}),
    ...(stringValue(row, "execution_run_id")
      ? { runId: stringValue(row, "execution_run_id") }
      : {}),
    startedAt: requiredNumber(row, "execution_started_at"),
    updatedAt: requiredNumber(row, "execution_updated_at"),
  };
}

function readMetadata(db: DatabaseSync, row: Row): WorkboardMetadata | undefined {
  const cardId = requiredString(row, "id");
  const attempts = childRows(db, "workboard_card_attempts", cardId).map((child) => {
    const entry: WorkboardRunAttempt = {
      id: requiredString(child, "id"),
      status: requiredString(child, "status") as WorkboardRunAttempt["status"],
      startedAt: requiredNumber(child, "started_at"),
    };
    const endedAt = numberValue(child, "ended_at");
    const engine = stringValue(child, "engine");
    const mode = stringValue(child, "mode");
    const model = stringValue(child, "model");
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    const error = stringValue(child, "error");
    if (endedAt !== undefined) {
      entry.endedAt = endedAt;
    }
    if (engine) {
      entry.engine = engine as WorkboardRunAttempt["engine"];
    }
    if (mode) {
      entry.mode = mode as WorkboardRunAttempt["mode"];
    }
    if (model) {
      entry.model = model;
    }
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    if (error) {
      entry.error = error;
    }
    return entry;
  });
  const comments = childRows(db, "workboard_card_comments", cardId).map((child) => {
    const entry: WorkboardComment = {
      id: requiredString(child, "id"),
      body: requiredString(child, "body"),
      createdAt: requiredNumber(child, "created_at"),
    };
    const updatedAt = numberValue(child, "updated_at");
    if (updatedAt !== undefined) {
      entry.updatedAt = updatedAt;
    }
    return entry;
  });
  const links = childRows(db, "workboard_card_links", cardId).map((child) => {
    const entry: WorkboardLink = {
      id: requiredString(child, "id"),
      type: requiredString(child, "type") as WorkboardLink["type"],
      createdAt: requiredNumber(child, "created_at"),
    };
    const targetCardId = stringValue(child, "target_card_id");
    const title = stringValue(child, "title");
    const url = stringValue(child, "url");
    if (targetCardId) {
      entry.targetCardId = targetCardId;
    }
    if (title) {
      entry.title = title;
    }
    if (url) {
      entry.url = url;
    }
    return entry;
  });
  const proof = childRows(db, "workboard_card_proof", cardId).map((child) => {
    const entry: WorkboardProof = {
      id: requiredString(child, "id"),
      status: requiredString(child, "status") as WorkboardProof["status"],
      createdAt: requiredNumber(child, "created_at"),
    };
    const label = stringValue(child, "label");
    const command = stringValue(child, "command");
    const url = stringValue(child, "url");
    const note = stringValue(child, "note");
    if (label) {
      entry.label = label;
    }
    if (command) {
      entry.command = command;
    }
    if (url) {
      entry.url = url;
    }
    if (note) {
      entry.note = note;
    }
    return entry;
  });
  const artifacts = childRows(db, "workboard_card_artifacts", cardId).map((child) => {
    const entry: WorkboardArtifact = {
      id: requiredString(child, "id"),
      createdAt: requiredNumber(child, "created_at"),
    };
    const label = stringValue(child, "label");
    const url = stringValue(child, "url");
    const artifactPath = stringValue(child, "path");
    const mimeType = stringValue(child, "mime_type");
    if (label) {
      entry.label = label;
    }
    if (url) {
      entry.url = url;
    }
    if (artifactPath) {
      entry.path = artifactPath;
    }
    if (mimeType) {
      entry.mimeType = mimeType;
    }
    return entry;
  });
  const attachments = childRows(db, "workboard_card_attachments", cardId).map((child) => {
    const entry: WorkboardAttachment = {
      id: requiredString(child, "id"),
      cardId: requiredString(child, "card_id"),
      createdAt: requiredNumber(child, "created_at"),
      fileName: requiredString(child, "file_name"),
      byteSize: requiredNumber(child, "byte_size"),
    };
    const mimeType = stringValue(child, "mime_type");
    const note = stringValue(child, "note");
    if (mimeType) {
      entry.mimeType = mimeType;
    }
    if (note) {
      entry.note = note;
    }
    return entry;
  });
  const workerLogs = childRows(db, "workboard_worker_logs", cardId).map((child) => {
    const entry: WorkboardWorkerLog = {
      id: requiredString(child, "id"),
      createdAt: requiredNumber(child, "created_at"),
      level: requiredString(child, "level") as WorkboardWorkerLog["level"],
      message: requiredString(child, "message"),
    };
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    return entry;
  });
  const diagnostics = childRows(db, "workboard_card_diagnostics", cardId).map((child) => ({
    kind: requiredString(child, "kind") as WorkboardDiagnostic["kind"],
    severity: requiredString(child, "severity") as WorkboardDiagnostic["severity"],
    title: requiredString(child, "title"),
    detail: requiredString(child, "detail"),
    firstSeenAt: requiredNumber(child, "first_seen_at"),
    lastSeenAt: requiredNumber(child, "last_seen_at"),
    count: requiredNumber(child, "count"),
    actions: (parseJson(child.actions_json) as WorkboardDiagnostic["actions"] | undefined) ?? [],
  }));
  const notifications = childRows(db, "workboard_card_notifications", cardId).map((child) => {
    const entry: WorkboardNotification = {
      id: requiredString(child, "id"),
      kind: requiredString(child, "kind") as WorkboardNotification["kind"],
      createdAt: requiredNumber(child, "created_at"),
      message: requiredString(child, "message"),
    };
    const sequence = numberValue(child, "sequence");
    const sessionKey = stringValue(child, "session_key");
    const runId = stringValue(child, "run_id");
    if (sequence !== undefined) {
      entry.sequence = sequence;
    }
    if (sessionKey) {
      entry.sessionKey = sessionKey;
    }
    if (runId) {
      entry.runId = runId;
    }
    return entry;
  });
  const protocol = db
    .prepare("SELECT * FROM workboard_worker_protocol WHERE card_id = ?")
    .get(cardId) as Row | undefined;
  const automation = parseJson(row.automation_json) as WorkboardMetadata["automation"] | undefined;
  const claim = parseJson(row.claim_json) as WorkboardMetadata["claim"] | undefined;
  const stale = parseJson(row.stale_json) as WorkboardMetadata["stale"] | undefined;
  const lifecycleStatusSourceUpdatedAt = numberValue(row, "lifecycle_status_source_updated_at");
  return optional({
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(links.length > 0 ? { links } : {}),
    ...(proof.length > 0 ? { proof } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(workerLogs.length > 0 ? { workerLogs } : {}),
    ...(protocol
      ? {
          workerProtocol: {
            state: requiredString(protocol, "state") as NonNullable<
              WorkboardMetadata["workerProtocol"]
            >["state"],
            updatedAt: requiredNumber(protocol, "updated_at"),
            ...(stringValue(protocol, "detail") ? { detail: stringValue(protocol, "detail") } : {}),
          },
        }
      : {}),
    ...(automation ? { automation } : {}),
    ...(claim ? { claim } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(notifications.length > 0 ? { notifications } : {}),
    ...(stringValue(row, "template_id")
      ? { templateId: stringValue(row, "template_id") as WorkboardMetadata["templateId"] }
      : {}),
    ...(numberValue(row, "archived_at") !== undefined
      ? { archivedAt: numberValue(row, "archived_at") }
      : {}),
    ...(stale ? { stale } : {}),
    ...(lifecycleStatusSourceUpdatedAt !== undefined ? { lifecycleStatusSourceUpdatedAt } : {}),
    ...(numberValue(row, "failure_count") !== undefined
      ? { failureCount: numberValue(row, "failure_count") }
      : {}),
  });
}

function readCard(db: DatabaseSync, row: Row): WorkboardCard {
  const card: WorkboardCard = {
    id: requiredString(row, "id"),
    title: requiredString(row, "title"),
    status: requiredString(row, "status") as WorkboardCard["status"],
    priority: requiredString(row, "priority") as WorkboardCard["priority"],
    labels: readLabels(db, requiredString(row, "id")),
    position: requiredNumber(row, "position"),
    createdAt: requiredNumber(row, "created_at"),
    updatedAt: requiredNumber(row, "updated_at"),
  };
  const metadata = readMetadata(db, row);
  return {
    ...card,
    ...(stringValue(row, "notes") ? { notes: stringValue(row, "notes") } : {}),
    ...(stringValue(row, "agent_id") ? { agentId: stringValue(row, "agent_id") } : {}),
    ...(stringValue(row, "session_key") ? { sessionKey: stringValue(row, "session_key") } : {}),
    ...(stringValue(row, "run_id") ? { runId: stringValue(row, "run_id") } : {}),
    ...(stringValue(row, "task_id") ? { taskId: stringValue(row, "task_id") } : {}),
    ...(stringValue(row, "source_url") ? { sourceUrl: stringValue(row, "source_url") } : {}),
    ...(readExecution(row) ? { execution: readExecution(row) } : {}),
    ...(numberValue(row, "started_at") !== undefined
      ? { startedAt: numberValue(row, "started_at") }
      : {}),
    ...(numberValue(row, "completed_at") !== undefined
      ? { completedAt: numberValue(row, "completed_at") }
      : {}),
    ...(readEvents(db, card.id) ? { events: readEvents(db, card.id) } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function bindNull(value: unknown): SQLInputValue {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return (value ?? null) as SQLInputValue;
  }
  return JSON.stringify(value);
}

function insertChildren<T>(
  db: DatabaseSync,
  table: string,
  cardId: string,
  entries: readonly T[] | undefined,
  insert: (entry: T, ordinal: number) => void,
): void {
  db.prepare(`DELETE FROM ${table} WHERE card_id = ?`).run(cardId);
  entries?.forEach(insert);
}

function insertCard(db: DatabaseSync, card: WorkboardCard): void {
  const execution = card.execution;
  const metadata = card.metadata;
  db.prepare(
    `
      INSERT INTO workboard_cards (
        id, board_id, title, notes, status, priority, agent_id, session_key, run_id, task_id,
        source_url, position, created_at, updated_at, started_at, completed_at,
        execution_id, execution_kind, execution_engine, execution_mode, execution_status,
        execution_model, execution_session_key, execution_run_id, execution_started_at,
        execution_updated_at, automation_json, claim_json, template_id, archived_at, stale_json,
        lifecycle_status_source_updated_at, failure_count
      ) VALUES (
        @id, @board_id, @title, @notes, @status, @priority, @agent_id, @session_key, @run_id,
        @task_id, @source_url, @position, @created_at, @updated_at, @started_at, @completed_at,
        @execution_id, @execution_kind, @execution_engine, @execution_mode, @execution_status,
        @execution_model, @execution_session_key, @execution_run_id, @execution_started_at,
        @execution_updated_at, @automation_json, @claim_json, @template_id, @archived_at,
        @stale_json, @lifecycle_status_source_updated_at, @failure_count
      )
      ON CONFLICT(id) DO UPDATE SET
        board_id = excluded.board_id,
        title = excluded.title,
        notes = excluded.notes,
        status = excluded.status,
        priority = excluded.priority,
        agent_id = excluded.agent_id,
        session_key = excluded.session_key,
        run_id = excluded.run_id,
        task_id = excluded.task_id,
        source_url = excluded.source_url,
        position = excluded.position,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        execution_id = excluded.execution_id,
        execution_kind = excluded.execution_kind,
        execution_engine = excluded.execution_engine,
        execution_mode = excluded.execution_mode,
        execution_status = excluded.execution_status,
        execution_model = excluded.execution_model,
        execution_session_key = excluded.execution_session_key,
        execution_run_id = excluded.execution_run_id,
        execution_started_at = excluded.execution_started_at,
        execution_updated_at = excluded.execution_updated_at,
        automation_json = excluded.automation_json,
        claim_json = excluded.claim_json,
        template_id = excluded.template_id,
        archived_at = excluded.archived_at,
        stale_json = excluded.stale_json,
        lifecycle_status_source_updated_at = excluded.lifecycle_status_source_updated_at,
        failure_count = excluded.failure_count
    `,
  ).run({
    id: card.id,
    board_id: cardBoardId(card),
    title: card.title,
    notes: bindNull(card.notes),
    status: card.status,
    priority: card.priority,
    agent_id: bindNull(card.agentId),
    session_key: bindNull(card.sessionKey),
    run_id: bindNull(card.runId),
    task_id: bindNull(card.taskId),
    source_url: bindNull(card.sourceUrl),
    position: card.position,
    created_at: card.createdAt,
    updated_at: card.updatedAt,
    started_at: bindNull(card.startedAt),
    completed_at: bindNull(card.completedAt),
    execution_id: bindNull(execution?.id),
    execution_kind: bindNull(execution?.kind),
    execution_engine: bindNull(execution?.engine),
    execution_mode: bindNull(execution?.mode),
    execution_status: bindNull(execution?.status),
    execution_model: bindNull(execution?.model),
    execution_session_key: bindNull(execution?.sessionKey),
    execution_run_id: bindNull(execution?.runId),
    execution_started_at: bindNull(execution?.startedAt),
    execution_updated_at: bindNull(execution?.updatedAt),
    automation_json: jsonValue(metadata?.automation),
    claim_json: jsonValue(metadata?.claim),
    template_id: bindNull(metadata?.templateId),
    archived_at: bindNull(metadata?.archivedAt),
    stale_json: jsonValue(metadata?.stale),
    lifecycle_status_source_updated_at: bindNull(metadata?.lifecycleStatusSourceUpdatedAt),
    failure_count: bindNull(metadata?.failureCount),
  });

  insertChildren(db, "workboard_card_labels", card.id, card.labels, (label, ordinal) => {
    db.prepare("INSERT INTO workboard_card_labels (card_id, ordinal, label) VALUES (?, ?, ?)").run(
      card.id,
      ordinal,
      label,
    );
  });
  insertChildren(db, "workboard_card_events", card.id, card.events, (event, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_card_events
          (id, card_id, ordinal, kind, at, from_status, to_status, session_key, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      event.id,
      card.id,
      ordinal,
      event.kind,
      event.at,
      bindNull(event.fromStatus),
      bindNull(event.toStatus),
      bindNull(event.sessionKey),
      bindNull(event.runId),
    );
  });
  insertChildren(db, "workboard_card_attempts", card.id, metadata?.attempts, (entry, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_card_attempts
          (id, card_id, ordinal, status, started_at, ended_at, engine, mode, model, session_key, run_id, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      entry.id,
      card.id,
      ordinal,
      entry.status,
      entry.startedAt,
      bindNull(entry.endedAt),
      bindNull(entry.engine),
      bindNull(entry.mode),
      bindNull(entry.model),
      bindNull(entry.sessionKey),
      bindNull(entry.runId),
      bindNull(entry.error),
    );
  });
  insertChildren(db, "workboard_card_comments", card.id, metadata?.comments, (entry, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_card_comments (id, card_id, ordinal, body, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(entry.id, card.id, ordinal, entry.body, entry.createdAt, bindNull(entry.updatedAt));
  });
  insertChildren(db, "workboard_card_links", card.id, metadata?.links, (entry, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_card_links
          (id, card_id, ordinal, type, target_card_id, title, url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      entry.id,
      card.id,
      ordinal,
      entry.type,
      bindNull(entry.targetCardId),
      bindNull(entry.title),
      bindNull(entry.url),
      entry.createdAt,
    );
  });
  insertChildren(db, "workboard_card_proof", card.id, metadata?.proof, (entry, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_card_proof
          (id, card_id, ordinal, status, label, command, url, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      entry.id,
      card.id,
      ordinal,
      entry.status,
      bindNull(entry.label),
      bindNull(entry.command),
      bindNull(entry.url),
      bindNull(entry.note),
      entry.createdAt,
    );
  });
  insertChildren(db, "workboard_card_artifacts", card.id, metadata?.artifacts, (entry, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_card_artifacts
          (id, card_id, ordinal, label, url, path, mime_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      entry.id,
      card.id,
      ordinal,
      bindNull(entry.label),
      bindNull(entry.url),
      bindNull(entry.path),
      bindNull(entry.mimeType),
      entry.createdAt,
    );
  });
  insertChildren(
    db,
    "workboard_card_attachments",
    card.id,
    metadata?.attachments,
    (entry, ordinal) => {
      db.prepare(
        `
          INSERT INTO workboard_card_attachments
            (id, card_id, ordinal, file_name, byte_size, mime_type, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        entry.id,
        entry.cardId,
        ordinal,
        entry.fileName,
        entry.byteSize,
        bindNull(entry.mimeType),
        bindNull(entry.note),
        entry.createdAt,
      );
    },
  );
  insertChildren(
    db,
    "workboard_card_diagnostics",
    card.id,
    metadata?.diagnostics,
    (entry, ordinal) => {
      db.prepare(
        `
          INSERT INTO workboard_card_diagnostics
            (card_id, ordinal, kind, severity, title, detail, first_seen_at, last_seen_at, count, actions_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        card.id,
        ordinal,
        entry.kind,
        entry.severity,
        entry.title,
        entry.detail,
        entry.firstSeenAt,
        entry.lastSeenAt,
        entry.count,
        JSON.stringify(entry.actions),
      );
    },
  );
  insertChildren(
    db,
    "workboard_card_notifications",
    card.id,
    metadata?.notifications,
    (entry, ordinal) => {
      db.prepare(
        `
          INSERT INTO workboard_card_notifications
            (id, card_id, ordinal, kind, message, created_at, sequence, session_key, run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        entry.id,
        card.id,
        ordinal,
        entry.kind,
        entry.message,
        entry.createdAt,
        bindNull(entry.sequence),
        bindNull(entry.sessionKey),
        bindNull(entry.runId),
      );
    },
  );
  insertChildren(db, "workboard_worker_logs", card.id, metadata?.workerLogs, (entry, ordinal) => {
    db.prepare(
      `
        INSERT INTO workboard_worker_logs
          (id, card_id, ordinal, level, message, created_at, session_key, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      entry.id,
      card.id,
      ordinal,
      entry.level,
      entry.message,
      entry.createdAt,
      bindNull(entry.sessionKey),
      bindNull(entry.runId),
    );
  });
  db.prepare("DELETE FROM workboard_worker_protocol WHERE card_id = ?").run(card.id);
  if (metadata?.workerProtocol) {
    db.prepare(
      `
        INSERT INTO workboard_worker_protocol (card_id, state, updated_at, detail)
        VALUES (?, ?, ?, ?)
      `,
    ).run(
      card.id,
      metadata.workerProtocol.state,
      metadata.workerProtocol.updatedAt,
      bindNull(metadata.workerProtocol.detail),
    );
  }
}

// Hydrated projection handed to the store-layer judge inside the atomic transaction.
export type WorkboardAtomicStoredCardRow = {
  cardId: string;
  boardId: string;
  title: string;
  notes: string | null;
  status: string;
  priority: string;
  labels: string[];
  agentId: string | null;
  claimJson: string | null;
  executionId: string | null;
  startedAt: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  attemptCount: number;
  correlationKey: string | null;
  governanceSpecVersion: number | null;
  governanceSpecJson: string | null;
  governanceFingerprint: string | null;
};

export type WorkboardAtomicJudgeVerdict = {
  decision: "recovered" | "conflict" | "stored_record_invalid" | "state_incompatible";
  detailCode: string | null;
  storedFingerprint: string | null;
};

export type WorkboardAtomicNewCardInput = {
  cardId: string;
  createdEventId: string;
  boardId: string;
  title: string;
  notes: string;
  labels: readonly string[];
  governanceSpecJson: string;
  governanceFingerprint: string;
};

export type WorkboardAtomicCreateStoreResult =
  | { kind: "migration_required" }
  | { kind: "unavailable" }
  | { kind: "created"; receiptId: string }
  | {
      kind: "existing";
      verdict: WorkboardAtomicJudgeVerdict;
      row: WorkboardAtomicStoredCardRow;
      receiptId: string;
    }
  | {
      kind: "refused_no_row";
      reasonCode: "workboard_stored_record_invalid" | "workboard_incompatible_legacy_card";
      receiptId: string;
      cardId: string | null;
      detailCode: string | null;
    }
  | { kind: "storage_failure" }
  | { kind: "uncertain" };

export type WorkboardAtomicCreateStoreRequest = {
  correlationKey: string;
  requestFingerprint: string;
  receiptId: string;
  newCard: WorkboardAtomicNewCardInput;
  now: number;
};

export type WorkboardAtomicReceiptRow = {
  id: string;
  correlationKey: string;
  cardId: string | null;
  requestFingerprint: string;
  storedFingerprint: string | null;
  outcome: string;
  reasonCode: string;
  detailCode: string | null;
  createdAt: number;
};

// Capability surface the store layer detects before treating an injected keyed store
// as the SQLite atomic authority. Memory/test stores lack it and the boundary then
// refuses with workboard_unavailable instead of falling back (contract invariant 15).
export type WorkboardAtomicCapableCardStore = {
  atomicCreateOrRecover(
    request: WorkboardAtomicCreateStoreRequest,
    judge: (row: WorkboardAtomicStoredCardRow) => WorkboardAtomicJudgeVerdict,
  ): WorkboardAtomicCreateStoreResult;
  getAtomicCreateReceipt(id: string): WorkboardAtomicReceiptRow | null;
  isCorrelatedCard(id: string): boolean;
  verifyAtomicMigrationComplete(): boolean;
};

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(row: Row, key: string): number | null {
  const value = numberValue(row, key);
  return value === undefined ? null : value;
}

// SQLite reports a partial-unique-index violation by column, e.g.
// "UNIQUE constraint failed: workboard_cards.correlation_key".
function isCorrelationUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("workboard_cards.correlation_key")
  );
}

class WorkboardSqliteCardStore implements WorkboardKeyedStore, WorkboardAtomicCapableCardStore {
  constructor(private readonly db: DatabaseSync) {}

  verifyAtomicMigrationComplete(): boolean {
    try {
      return workboardAtomicSchemaComplete(this.db);
    } catch {
      return false;
    }
  }

  isCorrelatedCard(id: string): boolean {
    if (!this.verifyAtomicMigrationComplete()) {
      return false;
    }
    const row = this.db
      .prepare("SELECT correlation_key FROM workboard_cards WHERE id = ?")
      .get(id) as Row | undefined;
    return typeof row?.correlation_key === "string" && row.correlation_key.length > 0;
  }

  getAtomicCreateReceipt(id: string): WorkboardAtomicReceiptRow | null {
    if (!this.verifyAtomicMigrationComplete()) {
      return null;
    }
    const row = this.db.prepare(`SELECT * FROM ${ATOMIC_RECEIPTS_TABLE} WHERE id = ?`).get(id) as
      | Row
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: requiredString(row, "id"),
      correlationKey: requiredString(row, "correlation_key"),
      cardId: nullableString(row, "card_id"),
      requestFingerprint: requiredString(row, "request_fingerprint"),
      storedFingerprint: nullableString(row, "stored_fingerprint"),
      outcome: requiredString(row, "outcome"),
      reasonCode: requiredString(row, "reason_code"),
      detailCode: nullableString(row, "detail_code"),
      createdAt: requiredNumber(row, "created_at"),
    };
  }

  private insertAtomicReceipt(receipt: {
    id: string;
    correlationKey: string;
    cardId: string | null;
    requestFingerprint: string;
    storedFingerprint: string | null;
    outcome: string;
    reasonCode: string;
    detailCode: string | null;
    createdAt: number;
  }): void {
    atomicTestFaultPoint("insert-receipt");
    this.db
      .prepare(
        `
          INSERT INTO ${ATOMIC_RECEIPTS_TABLE}
            (id, correlation_key, card_id, request_fingerprint, stored_fingerprint,
             outcome, reason_code, detail_code, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        receipt.id,
        receipt.correlationKey,
        receipt.cardId,
        receipt.requestFingerprint,
        receipt.storedFingerprint,
        receipt.outcome,
        receipt.reasonCode,
        receipt.detailCode,
        receipt.createdAt,
      );
  }

  private hydrateAtomicRow(row: Row): WorkboardAtomicStoredCardRow {
    const cardId = requiredString(row, "id");
    return {
      cardId,
      boardId: requiredString(row, "board_id"),
      title: requiredString(row, "title"),
      notes: nullableString(row, "notes"),
      status: requiredString(row, "status"),
      priority: requiredString(row, "priority"),
      labels: readLabels(this.db, cardId),
      agentId: nullableString(row, "agent_id"),
      claimJson: nullableString(row, "claim_json"),
      executionId: nullableString(row, "execution_id"),
      startedAt: nullableNumber(row, "started_at"),
      completedAt: nullableNumber(row, "completed_at"),
      archivedAt: nullableNumber(row, "archived_at"),
      attemptCount: requiredNumber(row, "attempt_count"),
      correlationKey: nullableString(row, "correlation_key"),
      governanceSpecVersion: nullableNumber(row, "governance_spec_version"),
      governanceSpecJson: nullableString(row, "governance_spec_json"),
      governanceFingerprint: nullableString(row, "governance_fingerprint"),
    };
  }

  // Rows other than `excludeCardId` whose legacy automation payload advertises the key.
  // Returns candidate ids in deterministic order plus the first row whose payload is
  // unreadable (contract §6.3: malformed legacy metadata fails closed).
  private scanLegacyAdvertisers(
    correlationKey: string,
    excludeCardId: string | null,
  ): { candidateIds: string[]; malformedId: string | null } {
    const rows = this.db
      .prepare(
        `
          SELECT id, automation_json FROM workboard_cards
          WHERE correlation_key IS NULL
            AND automation_json IS NOT NULL
            AND instr(automation_json, ?) > 0
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(correlationKey) as Row[];
    const candidateIds: string[] = [];
    let malformedId: string | null = null;
    for (const row of rows) {
      const id = requiredString(row, "id");
      if (excludeCardId !== null && id === excludeCardId) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(row.automation_json));
      } catch {
        malformedId ??= id;
        continue;
      }
      const idempotencyKey =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).idempotencyKey
          : undefined;
      if (idempotencyKey === correlationKey) {
        candidateIds.push(id);
      }
    }
    return { candidateIds, malformedId };
  }

  // Contract §2.3: one BEGIN IMMEDIATE transaction covering indexed lookup, legacy
  // detection, hydration/judgement, insert or receipt append, and a single commit.
  // The unique correlation index is the final arbiter; a losing racer re-reads the
  // winning row in a fresh transaction. No successful result is returned pre-commit.
  atomicCreateOrRecover(
    request: WorkboardAtomicCreateStoreRequest,
    judge: (row: WorkboardAtomicStoredCardRow) => WorkboardAtomicJudgeVerdict,
  ): WorkboardAtomicCreateStoreResult {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = this.atomicCreateOrRecoverAttempt(request, judge, attempt === 0);
      if (result !== "race_lost") {
        return result;
      }
    }
    // The insert lost the uniqueness race but the winning row was gone on re-read.
    // Correlated rows cannot be physically deleted, so this is a rolled-back anomaly.
    return { kind: "storage_failure" };
  }

  private atomicCreateOrRecoverAttempt(
    request: WorkboardAtomicCreateStoreRequest,
    judge: (row: WorkboardAtomicStoredCardRow) => WorkboardAtomicJudgeVerdict,
    allowRaceRetry: boolean,
  ): WorkboardAtomicCreateStoreResult | "race_lost" {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      return { kind: "unavailable" };
    }
    let phase: "work" | "commit" = "work";
    try {
      if (!workboardAtomicSchemaComplete(this.db)) {
        this.db.exec("ROLLBACK");
        return { kind: "migration_required" };
      }
      const indexedRow = this.db
        .prepare(
          `
            SELECT c.*,
              (SELECT COUNT(*) FROM workboard_card_attempts a WHERE a.card_id = c.id)
                AS attempt_count
            FROM workboard_cards c
            WHERE c.correlation_key = ?
          `,
        )
        .get(request.correlationKey) as Row | undefined;
      let outcome: WorkboardAtomicCreateStoreResult;
      if (indexedRow) {
        const hydrated = this.hydrateAtomicRow(indexedRow);
        const advertisers = this.scanLegacyAdvertisers(request.correlationKey, hydrated.cardId);
        if (advertisers.malformedId !== null || advertisers.candidateIds.length > 0) {
          this.insertAtomicReceipt({
            id: request.receiptId,
            correlationKey: request.correlationKey,
            cardId: hydrated.cardId,
            requestFingerprint: request.requestFingerprint,
            storedFingerprint: null,
            outcome: "refused",
            reasonCode: "workboard_stored_record_invalid",
            detailCode: "indexed-legacy-mismatch",
            createdAt: request.now,
          });
          outcome = {
            kind: "refused_no_row",
            reasonCode: "workboard_stored_record_invalid",
            receiptId: request.receiptId,
            cardId: hydrated.cardId,
            detailCode: "indexed-legacy-mismatch",
          };
        } else {
          const verdict = judge(hydrated);
          const reasonCode =
            verdict.decision === "recovered"
              ? "workboard_card_recovered"
              : verdict.decision === "conflict"
                ? "workboard_card_conflict"
                : verdict.decision === "stored_record_invalid"
                  ? "workboard_stored_record_invalid"
                  : "workboard_card_state_incompatible";
          this.insertAtomicReceipt({
            id: request.receiptId,
            correlationKey: request.correlationKey,
            cardId: hydrated.cardId,
            requestFingerprint: request.requestFingerprint,
            storedFingerprint: verdict.storedFingerprint,
            outcome: verdict.decision === "recovered" ? "recovered" : "refused",
            reasonCode,
            detailCode: verdict.detailCode,
            createdAt: request.now,
          });
          outcome = { kind: "existing", verdict, row: hydrated, receiptId: request.receiptId };
        }
      } else {
        const legacy = this.scanLegacyAdvertisers(request.correlationKey, null);
        if (legacy.malformedId !== null) {
          this.insertAtomicReceipt({
            id: request.receiptId,
            correlationKey: request.correlationKey,
            cardId: legacy.malformedId,
            requestFingerprint: request.requestFingerprint,
            storedFingerprint: null,
            outcome: "refused",
            reasonCode: "workboard_stored_record_invalid",
            detailCode: "legacy-metadata-malformed",
            createdAt: request.now,
          });
          outcome = {
            kind: "refused_no_row",
            reasonCode: "workboard_stored_record_invalid",
            receiptId: request.receiptId,
            cardId: legacy.malformedId,
            detailCode: "legacy-metadata-malformed",
          };
        } else if (legacy.candidateIds.length > 0) {
          const detailCode =
            legacy.candidateIds.length === 1
              ? null
              : `legacy-candidates-${legacy.candidateIds.length}`;
          const cardId = legacy.candidateIds.length === 1 ? (legacy.candidateIds[0] ?? null) : null;
          this.insertAtomicReceipt({
            id: request.receiptId,
            correlationKey: request.correlationKey,
            cardId,
            requestFingerprint: request.requestFingerprint,
            storedFingerprint: null,
            outcome: "refused",
            reasonCode: "workboard_incompatible_legacy_card",
            detailCode,
            createdAt: request.now,
          });
          outcome = {
            kind: "refused_no_row",
            reasonCode: "workboard_incompatible_legacy_card",
            receiptId: request.receiptId,
            cardId,
            detailCode,
          };
        } else {
          this.insertAtomicCard(request);
          this.insertAtomicReceipt({
            id: request.receiptId,
            correlationKey: request.correlationKey,
            cardId: request.newCard.cardId,
            requestFingerprint: request.requestFingerprint,
            storedFingerprint: request.newCard.governanceFingerprint,
            outcome: "created",
            reasonCode: "workboard_card_created",
            createdAt: request.now,
            detailCode: null,
          });
          outcome = { kind: "created", receiptId: request.receiptId };
        }
      }
      atomicTestFaultPoint("pre-commit");
      atomicTestCrashPoint("atomic-before-commit");
      phase = "commit";
      this.db.exec("COMMIT");
      atomicTestCrashPoint("atomic-after-commit");
      return outcome;
    } catch (error) {
      let rolledBack = false;
      try {
        this.db.exec("ROLLBACK");
        rolledBack = true;
      } catch {
        // rollback also failed; commit state is unknowable below
      }
      if (phase === "commit") {
        // An exception at/after COMMIT leaves the commit status unknowable
        // (contract §4.2); only a same-key retry is safe.
        return { kind: "uncertain" };
      }
      if (!rolledBack) {
        return { kind: "uncertain" };
      }
      if (allowRaceRetry && isCorrelationUniqueViolation(error)) {
        return "race_lost";
      }
      return { kind: "storage_failure" };
    }
  }

  // The dedicated atomic insert is the only store symbol permitted to populate the
  // four authority columns (contract §6.4). Generic insertCard() never names them.
  private insertAtomicCard(request: WorkboardAtomicCreateStoreRequest): void {
    atomicTestFaultPoint("insert-card");
    const card = request.newCard;
    this.db
      .prepare(
        `
          INSERT INTO workboard_cards (
            id, board_id, title, notes, status, priority, position,
            created_at, updated_at, automation_json,
            correlation_key, governance_spec_version, governance_spec_json,
            governance_fingerprint
          ) VALUES (
            @id, @board_id, @title, @notes, 'backlog', 'normal',
            COALESCE((SELECT MAX(position) FROM workboard_cards WHERE status = 'backlog'), 0)
              + 1000,
            @now, @now, @automation_json,
            @correlation_key, 1, @governance_spec_json, @governance_fingerprint
          )
        `,
      )
      .run({
        id: card.cardId,
        board_id: card.boardId,
        title: card.title,
        notes: card.notes,
        now: request.now,
        automation_json: JSON.stringify({ boardId: card.boardId }),
        correlation_key: request.correlationKey,
        governance_spec_json: card.governanceSpecJson,
        governance_fingerprint: card.governanceFingerprint,
      });
    const insertLabel = this.db.prepare(
      "INSERT INTO workboard_card_labels (card_id, ordinal, label) VALUES (?, ?, ?)",
    );
    card.labels.forEach((label, ordinal) => {
      insertLabel.run(card.cardId, ordinal, label);
    });
    this.db
      .prepare(
        `
          INSERT INTO workboard_card_events (id, card_id, ordinal, kind, at, to_status)
          VALUES (?, ?, 0, 'created', ?, 'backlog')
        `,
      )
      .run(card.createdEventId, card.cardId, request.now);
  }

  async register(key: string, value: PersistedWorkboardCard): Promise<void> {
    if (value.version !== 1 || value.card.id !== key) {
      throw new Error("invalid workboard card payload");
    }
    runTransaction(this.db, () => insertCard(this.db, value.card));
  }

  async lookup(key: string): Promise<PersistedWorkboardCard | undefined> {
    const row = this.db.prepare("SELECT * FROM workboard_cards WHERE id = ?").get(key) as
      | Row
      | undefined;
    return row ? { version: 1, card: readCard(this.db, row) } : undefined;
  }

  async delete(key: string): Promise<boolean> {
    const result = runTransaction(this.db, () => {
      this.db
        .prepare(
          `
            DELETE FROM workboard_attachment_blobs
            WHERE attachment_id IN (
              SELECT id FROM workboard_card_attachments WHERE card_id = ?
            )
          `,
        )
        .run(key);
      return this.db.prepare("DELETE FROM workboard_cards WHERE id = ?").run(key);
    });
    return result.changes > 0;
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardCard }>> {
    return (
      this.db
        .prepare("SELECT * FROM workboard_cards ORDER BY created_at ASC, id ASC")
        .all() as Row[]
    ).map((row) => ({
      key: requiredString(row, "id"),
      value: { version: 1, card: readCard(this.db, row) },
    }));
  }
}

class WorkboardSqliteBoardStore implements WorkboardKeyedStore<PersistedWorkboardBoard> {
  constructor(private readonly db: DatabaseSync) {}

  async register(key: string, value: PersistedWorkboardBoard): Promise<void> {
    if (value.version !== 1 || value.board.id !== key) {
      throw new Error("invalid workboard board payload");
    }
    const board = value.board;
    this.db
      .prepare(
        `
          INSERT INTO workboard_boards (
            id, name, description, icon, color, default_workspace_json, orchestration_json,
            created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            icon = excluded.icon,
            color = excluded.color,
            default_workspace_json = excluded.default_workspace_json,
            orchestration_json = excluded.orchestration_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            archived_at = excluded.archived_at
        `,
      )
      .run(
        board.id,
        bindNull(board.name),
        bindNull(board.description),
        bindNull(board.icon),
        bindNull(board.color),
        jsonValue(board.defaultWorkspace),
        jsonValue(board.orchestration),
        board.createdAt,
        board.updatedAt,
        bindNull(board.archivedAt),
      );
  }

  async lookup(key: string): Promise<PersistedWorkboardBoard | undefined> {
    const row = this.db.prepare("SELECT * FROM workboard_boards WHERE id = ?").get(key) as
      | Row
      | undefined;
    if (!row) {
      return undefined;
    }
    const defaultWorkspace = parseJson(row.default_workspace_json) as
      | PersistedWorkboardBoard["board"]["defaultWorkspace"]
      | undefined;
    const orchestration = parseJson(row.orchestration_json) as
      | PersistedWorkboardBoard["board"]["orchestration"]
      | undefined;
    return {
      version: 1,
      board: {
        id: requiredString(row, "id"),
        ...(stringValue(row, "name") ? { name: stringValue(row, "name") } : {}),
        ...(stringValue(row, "description")
          ? { description: stringValue(row, "description") }
          : {}),
        ...(stringValue(row, "icon") ? { icon: stringValue(row, "icon") } : {}),
        ...(stringValue(row, "color") ? { color: stringValue(row, "color") } : {}),
        ...(defaultWorkspace ? { defaultWorkspace } : {}),
        ...(orchestration ? { orchestration } : {}),
        createdAt: requiredNumber(row, "created_at"),
        updatedAt: requiredNumber(row, "updated_at"),
        ...(numberValue(row, "archived_at") !== undefined
          ? { archivedAt: numberValue(row, "archived_at") }
          : {}),
      },
    };
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM workboard_boards WHERE id = ?").run(key);
    return result.changes > 0;
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardBoard }>> {
    const rows = this.db.prepare("SELECT id FROM workboard_boards ORDER BY id ASC").all() as Row[];
    const entries: Array<{ key: string; value: PersistedWorkboardBoard }> = [];
    for (const row of rows) {
      const key = requiredString(row, "id");
      const value = await this.lookup(key);
      if (value) {
        entries.push({ key, value });
      }
    }
    return entries;
  }
}

class WorkboardSqliteSubscriptionStore implements WorkboardKeyedStore<PersistedWorkboardNotificationSubscription> {
  constructor(private readonly db: DatabaseSync) {}

  async register(key: string, value: PersistedWorkboardNotificationSubscription): Promise<void> {
    if (value.version !== 1 || value.subscription.id !== key) {
      throw new Error("invalid workboard notification subscription payload");
    }
    const subscription = value.subscription;
    this.db
      .prepare(
        `
          INSERT INTO workboard_notification_subscriptions (
            id, board_id, card_id, session_key, run_id, target, event_kinds_json,
            last_event_at, last_event_id, last_event_sequence, delivered_event_ids_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            board_id = excluded.board_id,
            card_id = excluded.card_id,
            session_key = excluded.session_key,
            run_id = excluded.run_id,
            target = excluded.target,
            event_kinds_json = excluded.event_kinds_json,
            last_event_at = excluded.last_event_at,
            last_event_id = excluded.last_event_id,
            last_event_sequence = excluded.last_event_sequence,
            delivered_event_ids_json = excluded.delivered_event_ids_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        subscription.id,
        subscription.boardId,
        bindNull(subscription.cardId),
        bindNull(subscription.sessionKey),
        bindNull(subscription.runId),
        bindNull(subscription.target),
        jsonValue(subscription.eventKinds),
        bindNull(subscription.lastEventAt),
        bindNull(subscription.lastEventId),
        bindNull(subscription.lastEventSequence),
        jsonValue(subscription.deliveredEventIds),
        subscription.createdAt,
        subscription.updatedAt,
      );
  }

  async lookup(key: string): Promise<PersistedWorkboardNotificationSubscription | undefined> {
    const row = this.db
      .prepare("SELECT * FROM workboard_notification_subscriptions WHERE id = ?")
      .get(key) as Row | undefined;
    if (!row) {
      return undefined;
    }
    const eventKinds = parseJson(row.event_kinds_json) as
      | PersistedWorkboardNotificationSubscription["subscription"]["eventKinds"]
      | undefined;
    const deliveredEventIds = parseJson(row.delivered_event_ids_json) as
      | PersistedWorkboardNotificationSubscription["subscription"]["deliveredEventIds"]
      | undefined;
    return {
      version: 1,
      subscription: {
        id: requiredString(row, "id"),
        boardId: requiredString(row, "board_id"),
        ...(stringValue(row, "card_id") ? { cardId: stringValue(row, "card_id") } : {}),
        ...(stringValue(row, "session_key") ? { sessionKey: stringValue(row, "session_key") } : {}),
        ...(stringValue(row, "run_id") ? { runId: stringValue(row, "run_id") } : {}),
        ...(stringValue(row, "target") ? { target: stringValue(row, "target") } : {}),
        ...(eventKinds ? { eventKinds } : {}),
        ...(numberValue(row, "last_event_at") !== undefined
          ? { lastEventAt: numberValue(row, "last_event_at") }
          : {}),
        ...(stringValue(row, "last_event_id")
          ? { lastEventId: stringValue(row, "last_event_id") }
          : {}),
        ...(numberValue(row, "last_event_sequence") !== undefined
          ? { lastEventSequence: numberValue(row, "last_event_sequence") }
          : {}),
        ...(deliveredEventIds ? { deliveredEventIds } : {}),
        createdAt: requiredNumber(row, "created_at"),
        updatedAt: requiredNumber(row, "updated_at"),
      },
    };
  }

  async delete(key: string): Promise<boolean> {
    const result = this.db
      .prepare("DELETE FROM workboard_notification_subscriptions WHERE id = ?")
      .run(key);
    return result.changes > 0;
  }

  async entries(): Promise<
    Array<{ key: string; value: PersistedWorkboardNotificationSubscription }>
  > {
    const rows = this.db
      .prepare(
        "SELECT id FROM workboard_notification_subscriptions ORDER BY created_at ASC, id ASC",
      )
      .all() as Row[];
    const entries: Array<{ key: string; value: PersistedWorkboardNotificationSubscription }> = [];
    for (const row of rows) {
      const key = requiredString(row, "id");
      const value = await this.lookup(key);
      if (value) {
        entries.push({ key, value });
      }
    }
    return entries;
  }
}

class WorkboardSqliteAttachmentStore implements WorkboardKeyedStore<PersistedWorkboardAttachment> {
  constructor(private readonly db: DatabaseSync) {}

  async register(key: string, value: PersistedWorkboardAttachment): Promise<void> {
    if (value.version !== 1 || value.attachment.id !== key) {
      throw new Error("invalid workboard attachment payload");
    }
    const attachment = value.attachment;
    this.db
      .prepare(
        `
          INSERT INTO workboard_attachment_blobs (attachment_id, content)
          VALUES (?, ?)
          ON CONFLICT(attachment_id) DO UPDATE SET content = excluded.content
        `,
      )
      .run(attachment.id, asBlobContent(value.contentBase64));
  }

  async lookup(key: string): Promise<PersistedWorkboardAttachment | undefined> {
    const row = this.db
      .prepare(
        `
          SELECT a.*, b.content
          FROM workboard_card_attachments a
          JOIN workboard_attachment_blobs b ON b.attachment_id = a.id
          WHERE a.id = ?
        `,
      )
      .get(key) as Row | undefined;
    if (!row) {
      return undefined;
    }
    return {
      version: 1,
      attachment: {
        id: requiredString(row, "id"),
        cardId: requiredString(row, "card_id"),
        createdAt: requiredNumber(row, "created_at"),
        fileName: requiredString(row, "file_name"),
        byteSize: requiredNumber(row, "byte_size"),
        ...(stringValue(row, "mime_type") ? { mimeType: stringValue(row, "mime_type") } : {}),
        ...(stringValue(row, "note") ? { note: stringValue(row, "note") } : {}),
      },
      contentBase64: blobToBase64(row.content),
    };
  }

  async delete(key: string): Promise<boolean> {
    const deleted = runTransaction(this.db, () => {
      this.db.prepare("DELETE FROM workboard_attachment_blobs WHERE attachment_id = ?").run(key);
      return this.db.prepare("DELETE FROM workboard_card_attachments WHERE id = ?").run(key);
    });
    return deleted.changes > 0;
  }

  async entries(): Promise<Array<{ key: string; value: PersistedWorkboardAttachment }>> {
    const rows = this.db
      .prepare(
        `
          SELECT a.id
          FROM workboard_card_attachments a
          JOIN workboard_attachment_blobs b ON b.attachment_id = a.id
          ORDER BY a.created_at ASC, a.id ASC
        `,
      )
      .all() as Row[];
    const entries: Array<{ key: string; value: PersistedWorkboardAttachment }> = [];
    for (const row of rows) {
      const key = requiredString(row, "id");
      const value = await this.lookup(key);
      if (value) {
        entries.push({ key, value });
      }
    }
    return entries;
  }
}

export function createWorkboardSqliteStores(
  options: {
    dbPath?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): WorkboardSqliteStores {
  const { db, maintenance } = createDatabase(
    options.dbPath ?? resolveWorkboardSqlitePath(options.env),
  );
  return {
    cards: new WorkboardSqliteCardStore(db),
    boards: new WorkboardSqliteBoardStore(db),
    subscriptions: new WorkboardSqliteSubscriptionStore(db),
    attachments: new WorkboardSqliteAttachmentStore(db),
    close: () => {
      maintenance.close();
      db.close();
    },
  };
}
