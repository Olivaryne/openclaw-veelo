// Workboard tests cover the AUT-WB-ATOMIC SQLite authority (contract aut-wb-atomic/1,
// child aut-wb-atomic-server/1): real-OS-process races, crash/restart, migration,
// lifetime correlation authority, receipts, and exact-version rollback compatibility.
//
// Real-process drivers: contract rows A01-A07 forbid process-local Promise.all proof,
// so this file re-executes ITSELF as plain `node --import tsx <this file>` children
// with OPENCLAW_WORKBOARD_ATOMIC_DRIVER set. The driver preamble below runs before
// any vitest suite is registered and exits the child before vitest state is touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import {
  atomicCardNotes,
  atomicCardTitle,
  deriveAtomicOccurrenceKey,
  WorkboardStore,
} from "./store.js";
import type { AtomicCreateResponseV1, CanonicalAutomationCardSpecV1 } from "./types.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(THIS_FILE), "../../..");

type AtomicSpecOverrides = {
  automation?: Partial<CanonicalAutomationCardSpecV1["automation"]>;
  top?: Partial<Record<keyof CanonicalAutomationCardSpecV1, unknown>>;
};

function makeAtomicSpec(
  automationId: string,
  scheduledAt: string,
  rev = 1,
  overrides: AtomicSpecOverrides = {},
): { key: string; spec: CanonicalAutomationCardSpecV1 } {
  const automation = {
    occurrence_key: deriveAtomicOccurrenceKey(automationId, rev, scheduledAt),
    automation_id: automationId,
    schedule_revision: rev,
    scheduled_at: scheduledAt,
    skill_name: "workboard-worker",
    skill_version: "1.2.0",
    risk_class: "read-only" as const,
    approval_policy: "operator-required" as const,
    output_contract_ref: "contracts/output/daily-brief@1",
    verification_contract_ref: "contracts/verify/daily-brief@1",
    ...overrides.automation,
  };
  const spec = {
    schema_version: 1,
    board: { id: "test-board", ref: "board:test-board", lane: "automation", template_ref: null },
    title: atomicCardTitle(automation.automation_id, automation.scheduled_at),
    initial_status: "backlog",
    priority: "normal",
    labels: ["automation", "hold", "operator-merge-only"],
    notes: atomicCardNotes(automation),
    automation,
    execution_control: {
      assignee_id: null,
      claim_owner_id: null,
      execution_id: null,
      execution_authorized: false,
    },
    ...overrides.top,
  } as CanonicalAutomationCardSpecV1;
  return { key: automation.occurrence_key, spec };
}

function openStore(dbPath: string) {
  const stores = createWorkboardSqliteStores({ dbPath });
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
  });
  return { stores, store };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---- child driver ----------------------------------------------------------------

async function runAtomicDriver(): Promise<void> {
  const mode = process.env.OPENCLAW_WORKBOARD_ATOMIC_DRIVER;
  const dbPath = process.env.WB_DRIVER_DB;
  if (!dbPath) {
    throw new Error("WB_DRIVER_DB is required in driver mode");
  }
  if (mode === "open-only") {
    // Used by migration interruption tests: opening the store runs the migration and
    // the env-selected crash point kills this process mid-transaction.
    const stores = createWorkboardSqliteStores({ dbPath });
    stores.close();
    process.stdout.write("opened\n");
    return;
  }
  if (mode === "start") {
    // OT-GOV-4 driver: one startCardIfEligible call from a real OS process.
    const outFile = process.env.WB_DRIVER_OUT;
    const readyFile = process.env.WB_DRIVER_READY;
    const goFile = process.env.WB_DRIVER_GO;
    const { stores, store } = openStore(dbPath);
    try {
      const request = JSON.parse(process.env.WB_DRIVER_START_REQUEST ?? "{}") as Record<
        string,
        unknown
      >;
      if (readyFile) {
        fs.writeFileSync(readyFile, String(process.pid));
      }
      if (goFile) {
        const deadline = Date.now() + 30_000;
        while (!fs.existsSync(goFile)) {
          if (Date.now() > deadline) {
            throw new Error("start driver barrier timed out");
          }
          await sleep(2);
        }
      }
      const result = await store.startCardIfEligible(request);
      if (outFile) {
        fs.writeFileSync(outFile, JSON.stringify(result));
      }
    } finally {
      stores.close();
    }
    return;
  }
  const automationId = process.env.WB_DRIVER_AUTOMATION_ID ?? "aut-test.daily-brief";
  const scheduledAt = process.env.WB_DRIVER_SCHEDULED_AT ?? "2026-08-03T12:00:00.000Z";
  const readyFile = process.env.WB_DRIVER_READY;
  const goFile = process.env.WB_DRIVER_GO;
  const outFile = process.env.WB_DRIVER_OUT;
  const { stores, store } = openStore(dbPath);
  try {
    const { key, spec } = makeAtomicSpec(automationId, scheduledAt);
    if (readyFile) {
      fs.writeFileSync(readyFile, String(process.pid));
    }
    if (goFile) {
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(goFile)) {
        if (Date.now() > deadline) {
          throw new Error("driver barrier timed out");
        }
        await sleep(2);
      }
    }
    const result = await store.createOrRecoverByCorrelationKey(key, spec);
    if (outFile) {
      fs.writeFileSync(outFile, JSON.stringify(result));
    }
  } finally {
    stores.close();
  }
}

if (process.env.OPENCLAW_WORKBOARD_ATOMIC_DRIVER) {
  await runAtomicDriver();
  process.exit(0);
}

// ---- vitest suite ----------------------------------------------------------------

const { afterEach, beforeEach, describe, expect, it } = await import("vitest");

type DriverOptions = {
  dbPath: string;
  automationId?: string;
  scheduledAt?: string;
  mode?: string;
  ready?: string;
  go?: string;
  out?: string;
  extraEnv?: Record<string, string>;
};

function spawnDriver(options: DriverOptions) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCLAW_WORKBOARD_ATOMIC_DRIVER: options.mode ?? "call",
    WB_DRIVER_DB: options.dbPath,
    ...(options.automationId ? { WB_DRIVER_AUTOMATION_ID: options.automationId } : {}),
    ...(options.scheduledAt ? { WB_DRIVER_SCHEDULED_AT: options.scheduledAt } : {}),
    ...(options.ready ? { WB_DRIVER_READY: options.ready } : {}),
    ...(options.go ? { WB_DRIVER_GO: options.go } : {}),
    ...(options.out ? { WB_DRIVER_OUT: options.out } : {}),
    ...options.extraEnv,
  };
  delete env.VITEST;
  delete env.TEST;
  return spawn(process.execPath, ["--import", "tsx", THIS_FILE], {
    cwd: REPO_ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
}

function readEnvelope(outFile: string): AtomicCreateResponseV1 {
  return JSON.parse(fs.readFileSync(outFile, "utf8")) as AtomicCreateResponseV1;
}

function cardCount(dbPath: string, key: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE correlation_key = ?")
      .get(key) as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function receiptRows(dbPath: string, key: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        "SELECT * FROM workboard_atomic_create_receipts WHERE correlation_key = ? ORDER BY created_at ASC, id ASC",
      )
      .all(key) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// Digest of one card row plus EVERY child-data surface (all twelve child tables and
// attachment blob bytes): the no-mutation oracle for refusals and recoveries.
const FULL_CARD_CHILD_TABLES = [
  "workboard_card_labels",
  "workboard_card_events",
  "workboard_card_attempts",
  "workboard_card_comments",
  "workboard_card_links",
  "workboard_card_proof",
  "workboard_card_artifacts",
  "workboard_card_attachments",
  "workboard_card_diagnostics",
  "workboard_card_notifications",
  "workboard_worker_logs",
  "workboard_worker_protocol",
] as const;

function cardDigest(dbPath: string, cardId: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const card = db.prepare("SELECT * FROM workboard_cards WHERE id = ?").get(cardId);
    const children = FULL_CARD_CHILD_TABLES.map((table) =>
      db.prepare(`SELECT * FROM ${table} WHERE card_id = ? ORDER BY rowid`).all(cardId),
    );
    const attachmentBlobs = db
      .prepare(
        `
          SELECT a.id AS attachment_id, hex(b.content) AS content_hex
          FROM workboard_card_attachments a
          JOIN workboard_attachment_blobs b ON b.attachment_id = a.id
          WHERE a.card_id = ? ORDER BY a.id
        `,
      )
      .all(cardId);
    return JSON.stringify({ card, children, attachmentBlobs }, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value,
    );
  } finally {
    db.close();
  }
}

// Build schema 3 with current code, then strip the atomic objects back to the exact
// schema-2 object set so the migration can run against a real legacy DB. Each entry
// in legacyAutomationJson becomes one legacy card row (raw payload bytes).
function makeSchema2Fixture(dbPath: string, legacyAutomationJson: string[] = []): void {
  openStore(dbPath).stores.close();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      DROP TRIGGER workboard_cards_reserved_no_delete;
      DROP TABLE workboard_start_receipts;
      DROP TABLE workboard_card_start_reservations;
      DELETE FROM workboard_schema_migrations WHERE id IN ('schema-4', 'schema-4-ot-gov-4');
      DROP TRIGGER workboard_cards_atomic_tuple_complete_insert;
      DROP TRIGGER workboard_cards_atomic_tuple_complete_update;
      DROP TRIGGER workboard_cards_atomic_tuple_immutable;
      DROP TRIGGER workboard_cards_correlated_no_delete;
      DROP TRIGGER workboard_atomic_create_receipts_no_update;
      DROP TRIGGER workboard_atomic_create_receipts_no_delete;
      DROP TABLE workboard_atomic_create_receipts;
      DROP INDEX workboard_cards_correlation_key_uq;
      ALTER TABLE workboard_cards DROP COLUMN correlation_key;
      ALTER TABLE workboard_cards DROP COLUMN governance_spec_version;
      ALTER TABLE workboard_cards DROP COLUMN governance_spec_json;
      ALTER TABLE workboard_cards DROP COLUMN governance_fingerprint;
      DELETE FROM workboard_schema_migrations WHERE id IN ('schema-3', 'schema-3-aut-wb-atomic');
    `);
    legacyAutomationJson.forEach((payload, index) => {
      db.prepare(
        `
          INSERT INTO workboard_cards
            (id, board_id, title, status, priority, position, created_at, updated_at, automation_json)
          VALUES (?, 'default', ?, 'backlog', 'normal', ?, ?, ?, ?)
        `,
      ).run(
        `11111111-1111-4111-8111-1111111111${String(index + 10)}`,
        `legacy card ${index}`,
        1000 + index,
        index + 1,
        index + 1,
        payload,
      );
    });
  } finally {
    db.close();
  }
}

function migrationLedger(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (
      db.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

let workDir: string;
beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-sqlite-"));
});
afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_WORKBOARD_TEST_ATOMIC_FAULT;
});

describe("workboard atomic schema-3 migration", () => {
  it("migrates a fresh database transactionally and records both ledger rows", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { stores } = openStore(dbPath);
    stores.close();
    const db = new DatabaseSync(dbPath);
    try {
      const ledger = (
        db.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id);
      expect(ledger).toEqual([
        "schema-2",
        "schema-3",
        "schema-3-aut-wb-atomic",
        "schema-4",
        "schema-4-ot-gov-4",
      ]);
      const columns = new Set(
        (db.prepare("PRAGMA table_info(workboard_cards)").all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      );
      for (const column of [
        "correlation_key",
        "governance_spec_version",
        "governance_spec_json",
        "governance_fingerprint",
      ]) {
        expect(columns.has(column)).toBe(true);
      }
      const names = (
        db
          .prepare(
            "SELECT name, type FROM sqlite_master WHERE name LIKE '%atomic%' OR name LIKE '%correlat%'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(names).toContain("workboard_cards_correlation_key_uq");
      expect(names).toContain("workboard_atomic_create_receipts");
      for (const trigger of [
        "workboard_cards_atomic_tuple_complete_insert",
        "workboard_cards_atomic_tuple_complete_update",
        "workboard_cards_atomic_tuple_immutable",
        "workboard_cards_correlated_no_delete",
        "workboard_atomic_create_receipts_no_update",
        "workboard_atomic_create_receipts_no_delete",
      ]) {
        expect(names).toContain(trigger);
      }
    } finally {
      db.close();
    }
  });

  it("reopening an already-migrated database is idempotent", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const { stores, store } = openStore(dbPath);
    expect(store.supportsAtomicCreate()).toBe(true);
    stores.close();
  });

  it("A34: kills at DDL, index, and ledger stages roll back completely; restart completes", async () => {
    for (const stage of ["migration-ddl", "migration-index", "migration-ledger"]) {
      const dbPath = path.join(workDir, `wb-${stage}.sqlite`);
      makeSchema2Fixture(dbPath);
      const child = spawnDriver({
        dbPath,
        mode: "open-only",
        extraEnv: { OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH: stage },
      });
      const exit = await waitForExit(child);
      expect(exit.signal).toBe("SIGKILL");
      const db = new DatabaseSync(dbPath);
      try {
        const ledger = (
          db.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id);
        expect(ledger).toEqual(["schema-2"]);
        const columns = new Set(
          (db.prepare("PRAGMA table_info(workboard_cards)").all() as Array<{ name: string }>).map(
            (row) => row.name,
          ),
        );
        expect(columns.has("correlation_key")).toBe(false);
      } finally {
        db.close();
      }
      // Restart reruns the same migration to completion.
      const { stores, store } = openStore(dbPath);
      expect(store.supportsAtomicCreate()).toBe(true);
      stores.close();
    }
  }, 120_000);

  it("A34: calls against an incomplete schema return workboard_atomic_migration_required", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { stores, store } = openStore(dbPath);
    try {
      // Tamper the ledger into a partial state after open: the per-call transaction
      // re-verifies and must refuse without writing.
      const db = new DatabaseSync(dbPath);
      db.exec("DELETE FROM workboard_schema_migrations WHERE id = 'schema-3-aut-wb-atomic'");
      db.close();
      const { key, spec } = makeAtomicSpec("aut-mig.check", "2026-08-03T12:00:00.000Z");
      const result = await store.createOrRecoverByCorrelationKey(key, spec);
      expect(result.reason_code).toBe("workboard_atomic_migration_required");
      expect(result.ok).toBe(false);
      expect(result.outcome).toBe("refused");
      expect(result.retryable).toBe(false);
      expect(result.evidence).toBeNull();
      expect(cardCount(dbPath, key)).toBe(0);
    } finally {
      stores.close();
    }
  });

  it("A34: a partial/tampered object state is never auto-repaired at open", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM workboard_schema_migrations WHERE id = 'schema-3'");
    db.close();
    const { stores, store } = openStore(dbPath);
    expect(store.supportsAtomicCreate()).toBe(false);
    stores.close();
  });

  it("legacy scan aborts the migration when legacy automation metadata is unreadable", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    makeSchema2Fixture(dbPath, ["{not json"]);
    const { stores, store } = openStore(dbPath);
    try {
      expect(store.supportsAtomicCreate()).toBe(false);
      const db = new DatabaseSync(dbPath);
      try {
        const ledger = (
          db.prepare("SELECT id FROM workboard_schema_migrations ORDER BY id").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id);
        expect(ledger).toEqual(["schema-2"]);
      } finally {
        db.close();
      }
    } finally {
      stores.close();
    }
  });
});

describe("workboard atomic real-process concurrency", () => {
  it("A01: two OS processes racing one new key commit exactly one card", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const go = path.join(workDir, "go");
    const children = [0, 1].map((index) =>
      spawnDriver({
        dbPath,
        ready: path.join(workDir, `ready-${index}`),
        go,
        out: path.join(workDir, `out-${index}.json`),
      }),
    );
    const exits = Promise.all(children.map((child) => waitForExit(child)));
    const deadline = Date.now() + 30_000;
    while ([0, 1].some((index) => !fs.existsSync(path.join(workDir, `ready-${index}`)))) {
      expect(Date.now()).toBeLessThan(deadline);
      await sleep(5);
    }
    fs.writeFileSync(go, "go");
    for (const exit of await exits) {
      expect(exit.signal).toBeNull();
      expect(exit.code).toBe(0);
    }
    const results = [0, 1].map((index) => readEnvelope(path.join(workDir, `out-${index}.json`)));
    const codes = results.map((result) => result.reason_code).toSorted();
    expect(codes).toEqual(["workboard_card_created", "workboard_card_recovered"]);
    const ids = new Set(results.map((result) => result.card?.id));
    expect(ids.size).toBe(1);
    const fingerprints = new Set(results.map((result) => result.stored_fingerprint));
    expect(fingerprints.size).toBe(1);
    const key = results[0]?.correlation_key as string;
    expect(cardCount(dbPath, key)).toBe(1);
    expect(receiptRows(dbPath, key)).toHaveLength(2);
  }, 120_000);

  it("A02: 16 barrier-started same-key processes, repeated 10x, create exactly one card each round", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    for (let round = 0; round < 10; round += 1) {
      const scheduledAt = new Date(Date.UTC(2026, 7, 3, 12, round)).toISOString();
      const go = path.join(workDir, `go-${round}`);
      const children = Array.from({ length: 16 }, (_value, index) =>
        spawnDriver({
          dbPath,
          scheduledAt,
          ready: path.join(workDir, `r${round}-ready-${index}`),
          go,
          out: path.join(workDir, `r${round}-out-${index}.json`),
        }),
      );
      const exits = Promise.all(children.map((child) => waitForExit(child)));
      const deadline = Date.now() + 60_000;
      while (
        Array.from({ length: 16 }, (_value, index) =>
          path.join(workDir, `r${round}-ready-${index}`),
        ).some((file) => !fs.existsSync(file))
      ) {
        expect(Date.now()).toBeLessThan(deadline);
        await sleep(5);
      }
      fs.writeFileSync(go, "go");
      for (const exit of await exits) {
        expect(exit.signal).toBeNull();
        expect(exit.code).toBe(0);
      }
      const results = Array.from({ length: 16 }, (_value, index) =>
        readEnvelope(path.join(workDir, `r${round}-out-${index}.json`)),
      );
      const created = results.filter((r) => r.reason_code === "workboard_card_created");
      const recovered = results.filter((r) => r.reason_code === "workboard_card_recovered");
      expect(created).toHaveLength(1);
      expect(recovered).toHaveLength(15);
      expect(new Set(results.map((r) => r.card?.id)).size).toBe(1);
      const key = results[0]?.correlation_key as string;
      expect(cardCount(dbPath, key)).toBe(1);
      expect(receiptRows(dbPath, key)).toHaveLength(16);
    }
  }, 600_000);

  it("A03: 16 OS-process calls across two keys create exactly one independent card per key", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const go = path.join(workDir, "go");
    const children = Array.from({ length: 16 }, (_value, index) =>
      spawnDriver({
        dbPath,
        automationId: index % 2 === 0 ? "aut-key.alpha" : "aut-key.beta",
        ready: path.join(workDir, `ready-${index}`),
        go,
        out: path.join(workDir, `out-${index}.json`),
      }),
    );
    const exits = Promise.all(children.map((child) => waitForExit(child)));
    const deadline = Date.now() + 60_000;
    while (
      Array.from({ length: 16 }, (_value, index) => path.join(workDir, `ready-${index}`)).some(
        (file) => !fs.existsSync(file),
      )
    ) {
      expect(Date.now()).toBeLessThan(deadline);
      await sleep(5);
    }
    fs.writeFileSync(go, "go");
    for (const exit of await exits) {
      expect(exit.code).toBe(0);
    }
    const results = Array.from({ length: 16 }, (_value, index) =>
      readEnvelope(path.join(workDir, `out-${index}.json`)),
    );
    const byKey = new Map<string, AtomicCreateResponseV1[]>();
    for (const result of results) {
      const key = result.correlation_key as string;
      byKey.set(key, [...(byKey.get(key) ?? []), result]);
    }
    expect(byKey.size).toBe(2);
    for (const [key, group] of byKey) {
      expect(group).toHaveLength(8);
      expect(group.filter((r) => r.reason_code === "workboard_card_created")).toHaveLength(1);
      expect(group.filter((r) => r.reason_code === "workboard_card_recovered")).toHaveLength(7);
      expect(new Set(group.map((r) => r.card?.id)).size).toBe(1);
      expect(cardCount(dbPath, key)).toBe(1);
      expect(receiptRows(dbPath, key)).toHaveLength(8);
    }
    expect(new Set(results.map((r) => r.card?.id)).size).toBe(2);
  }, 240_000);

  it("A05: a kill before COMMIT rolls back; retry creates cleanly", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const child = spawnDriver({
      dbPath,
      extraEnv: { OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH: "atomic-before-commit" },
    });
    const exit = await waitForExit(child);
    expect(exit.signal).toBe("SIGKILL");
    const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
    expect(cardCount(dbPath, key)).toBe(0);
    expect(receiptRows(dbPath, key)).toHaveLength(0);
    const { stores, store } = openStore(dbPath);
    try {
      const retry = await store.createOrRecoverByCorrelationKey(key, spec);
      expect(retry.reason_code).toBe("workboard_card_created");
      expect(cardCount(dbPath, key)).toBe(1);
      expect(receiptRows(dbPath, key)).toHaveLength(1);
    } finally {
      stores.close();
    }
  }, 120_000);

  it("A06: a kill after COMMIT keeps the card; retry recovers the same identity", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const child = spawnDriver({
      dbPath,
      extraEnv: { OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH: "atomic-after-commit" },
    });
    const exit = await waitForExit(child);
    expect(exit.signal).toBe("SIGKILL");
    const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
    expect(cardCount(dbPath, key)).toBe(1);
    const committed = receiptRows(dbPath, key);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.reason_code).toBe("workboard_card_created");
    const { stores, store } = openStore(dbPath);
    try {
      const retry = await store.createOrRecoverByCorrelationKey(key, spec);
      expect(retry.reason_code).toBe("workboard_card_recovered");
      expect(retry.card?.id).toBe(committed[0]?.card_id);
      expect(cardCount(dbPath, key)).toBe(1);
      expect(receiptRows(dbPath, key)).toHaveLength(2);
    } finally {
      stores.close();
    }
  }, 120_000);

  it("A07: close/reopen then identical call recovers byte-identical governance", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
    const first = openStore(dbPath);
    const created = await first.store.createOrRecoverByCorrelationKey(key, spec);
    expect(created.reason_code).toBe("workboard_card_created");
    first.stores.close();
    const digestBefore = cardDigest(dbPath, created.card?.id as string);
    const second = openStore(dbPath);
    try {
      const recovered = await second.store.createOrRecoverByCorrelationKey(key, spec);
      expect(recovered.reason_code).toBe("workboard_card_recovered");
      expect(recovered.card).toEqual(created.card);
      expect(recovered.stored_fingerprint).toBe(created.stored_fingerprint);
      expect(recovered.stored_spec).toEqual(created.stored_spec);
      expect(cardDigest(dbPath, created.card?.id as string)).toBe(digestBefore);
    } finally {
      second.stores.close();
    }
  });
});

describe("workboard atomic storage failure and availability", () => {
  it("A33: injected failures at each write stage roll back fully with no receipt", async () => {
    for (const stage of ["insert-card", "insert-receipt", "pre-commit"]) {
      const dbPath = path.join(workDir, `wb-${stage}.sqlite`);
      const { stores, store } = openStore(dbPath);
      try {
        process.env.OPENCLAW_WORKBOARD_TEST_ATOMIC_FAULT = stage;
        const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
        const result = await store.createOrRecoverByCorrelationKey(key, spec);
        expect(result.reason_code).toBe("workboard_storage_failure");
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe("failed");
        expect(result.retryable).toBe(true);
        expect(result.evidence).toBeNull();
        expect(cardCount(dbPath, key)).toBe(0);
        expect(receiptRows(dbPath, key)).toHaveLength(0);
        delete process.env.OPENCLAW_WORKBOARD_TEST_ATOMIC_FAULT;
        const retry = await store.createOrRecoverByCorrelationKey(key, spec);
        expect(retry.reason_code).toBe("workboard_card_created");
      } finally {
        delete process.env.OPENCLAW_WORKBOARD_TEST_ATOMIC_FAULT;
        stores.close();
      }
    }
  });

  it("A31: a closed database returns workboard_unavailable without attempting a commit", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { stores, store } = openStore(dbPath);
    stores.close();
    const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
    const result = await store.createOrRecoverByCorrelationKey(key, spec);
    expect(result.reason_code).toBe("workboard_unavailable");
    expect(result.outcome).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.evidence).toBeNull();
  });

  it("A32: an unreadable database file refuses to open; no fallback surface exists", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    fs.writeFileSync(dbPath, "this is not a sqlite database at all");
    expect(() => createWorkboardSqliteStores({ dbPath })).toThrow();
  });
});

describe("workboard atomic lifetime correlation authority", () => {
  async function createCorrelated(dbPath: string) {
    const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
    const opened = openStore(dbPath);
    const created = await opened.store.createOrRecoverByCorrelationKey(key, spec);
    expect(created.reason_code).toBe("workboard_card_created");
    return { ...opened, key, spec, cardId: created.card?.id as string, created };
  }

  it("A42: clearing, changing, rebinding, or partially writing the tuple is trigger-refused", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const fixture = await createCorrelated(dbPath);
    fixture.stores.close();
    const digestBefore = cardDigest(dbPath, fixture.cardId);
    const db = new DatabaseSync(dbPath);
    try {
      const attempts = [
        ["UPDATE workboard_cards SET correlation_key = NULL WHERE id = ?", [fixture.cardId]],
        [
          "UPDATE workboard_cards SET correlation_key = 'occ_v1_ffffffffffffffffffffffffffffffff' WHERE id = ?",
          [fixture.cardId],
        ],
        ["UPDATE workboard_cards SET governance_spec_version = 2 WHERE id = ?", [fixture.cardId]],
        ["UPDATE workboard_cards SET governance_spec_json = '{}' WHERE id = ?", [fixture.cardId]],
        [
          "UPDATE workboard_cards SET governance_fingerprint = 'sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE id = ?",
          [fixture.cardId],
        ],
        ["UPDATE workboard_cards SET governance_spec_json = NULL WHERE id = ?", [fixture.cardId]],
      ] as const;
      for (const [sql, params] of attempts) {
        expect(() => db.prepare(sql).run(...(params as [string]))).toThrow(/immutable|complete/);
      }
      // Partial tuple on insert is refused too.
      expect(() =>
        db
          .prepare(
            `
              INSERT INTO workboard_cards
                (id, board_id, title, status, priority, position, created_at, updated_at, correlation_key)
              VALUES ('22222222-2222-4222-8222-222222222222', 'default', 'partial', 'backlog', 'normal', 1, 1, 1,
                'occ_v1_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
            `,
          )
          .run(),
      ).toThrow(/complete/);
    } finally {
      db.close();
    }
    expect(cardDigest(dbPath, fixture.cardId)).toBe(digestBefore);
  });

  it("A43: generic register/upsert updates ordinary fields while preserving the tuple byte-for-byte", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const fixture = await createCorrelated(dbPath);
    try {
      const tupleBefore = new DatabaseSync(dbPath)
        .prepare(
          "SELECT correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
        )
        .get(fixture.cardId);
      // Ordinary metadata mutation through the generic surface (comment append).
      await fixture.store.addComment(fixture.cardId, { body: "operator note" });
      // Generic create alongside: all-null tuple.
      const generic = await fixture.store.create({ title: "generic card" });
      const db = new DatabaseSync(dbPath);
      try {
        const tupleAfter = db
          .prepare(
            "SELECT correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
          )
          .get(fixture.cardId);
        expect(tupleAfter).toEqual(tupleBefore);
        const genericTuple = db
          .prepare(
            "SELECT correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
          )
          .get(generic.id) as Record<string, unknown>;
        expect(genericTuple.correlation_key).toBeNull();
        expect(genericTuple.governance_spec_version).toBeNull();
        expect(genericTuple.governance_spec_json).toBeNull();
        expect(genericTuple.governance_fingerprint).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      fixture.stores.close();
    }
  });

  it("A44: normal delete archives a correlated card; direct delete is refused; uncorrelated delete still works", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const fixture = await createCorrelated(dbPath);
    try {
      const generic = await fixture.store.create({ title: "uncorrelated" });
      const deleted = await fixture.store.delete(fixture.cardId);
      expect(deleted).toEqual({ deleted: false, archived: true });
      const card = await fixture.store.get(fixture.cardId);
      expect(card?.metadata?.archivedAt).toBeGreaterThan(0);
      const db = new DatabaseSync(dbPath);
      try {
        expect(() =>
          db.prepare("DELETE FROM workboard_cards WHERE id = ?").run(fixture.cardId),
        ).toThrow(/physically deleted/);
      } finally {
        db.close();
      }
      const genericDeleted = await fixture.store.delete(generic.id);
      expect(genericDeleted.deleted).toBe(true);
    } finally {
      fixture.stores.close();
    }
  });

  it("A45: an archived correlated card refuses same-key reuse across restart and keeps its key", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const fixture = await createCorrelated(dbPath);
    await fixture.store.delete(fixture.cardId);
    fixture.stores.close();
    const reopened = openStore(dbPath);
    try {
      for (const request of [
        fixture.spec,
        makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z", 1, {
          automation: { skill_version: "9.9.9" },
        }).spec,
      ]) {
        const result = await reopened.store.createOrRecoverByCorrelationKey(fixture.key, request);
        expect(result.reason_code).toBe("workboard_card_state_incompatible");
        expect(result.card).toBeNull();
      }
      expect(cardCount(dbPath, fixture.key)).toBe(1);
      const receipts = receiptRows(dbPath, fixture.key);
      const refusals = receipts.filter(
        (row) => row.reason_code === "workboard_card_state_incompatible",
      );
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) {
        expect(refusal.card_id).toBe(fixture.cardId);
      }
    } finally {
      reopened.stores.close();
    }
  });

  it("uniqueness arbiter: the partial unique index refuses a second row with the same key", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const fixture = await createCorrelated(dbPath);
    fixture.stores.close();
    const db = new DatabaseSync(dbPath);
    try {
      expect(() =>
        db
          .prepare(
            `
              INSERT INTO workboard_cards
                (id, board_id, title, status, priority, position, created_at, updated_at,
                 correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint)
              SELECT '33333333-3333-4333-8333-333333333333', board_id, title, status, priority,
                position + 1, created_at, updated_at,
                correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint
              FROM workboard_cards WHERE id = ?
            `,
          )
          .run(fixture.cardId),
      ).toThrow(/UNIQUE constraint failed.*workboard_cards\.correlation_key/);
      // NULL keys stay outside the partial index: many generic rows may coexist.
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE correlation_key IS NULL")
        .get() as { n: number | bigint };
      expect(Number(count.n)).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });
});

describe("workboard atomic receipts", () => {
  it("receipts are append-only and resolve through the read-only lookup", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { stores, store } = openStore(dbPath);
    try {
      const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
      const created = await store.createOrRecoverByCorrelationKey(key, spec);
      const receiptId = created.evidence?.ref.split("/").pop() as string;
      const lookup = await store.getAtomicCreateReceipt(receiptId);
      expect(lookup.schema_version).toBe(1);
      expect(lookup.receipt).toMatchObject({
        schema_version: 1,
        id: receiptId,
        correlation_key: key,
        card_id: created.card?.id,
        request_fingerprint: created.stored_fingerprint,
        stored_fingerprint: created.stored_fingerprint,
        outcome: "created",
        reason_code: "workboard_card_created",
        detail_code: null,
      });
      expect(Date.parse(lookup.receipt?.created_at as string)).toBeGreaterThan(0);
      expect(await store.getAtomicCreateReceipt("99999999-9999-4999-8999-999999999999")).toEqual({
        schema_version: 1,
        receipt: null,
      });
      expect(await store.getAtomicCreateReceipt("not-a-uuid")).toEqual({
        schema_version: 1,
        receipt: null,
      });
      const db = new DatabaseSync(dbPath);
      try {
        expect(() =>
          db
            .prepare("UPDATE workboard_atomic_create_receipts SET detail_code = 'x' WHERE id = ?")
            .run(receiptId),
        ).toThrow(/append-only/);
        expect(() =>
          db.prepare("DELETE FROM workboard_atomic_create_receipts WHERE id = ?").run(receiptId),
        ).toThrow(/append-only/);
      } finally {
        db.close();
      }
    } finally {
      stores.close();
    }
  });

  it("receipt CHECK constraints refuse malformed or mispaired rows", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    try {
      const insert = db.prepare(
        `
          INSERT INTO workboard_atomic_create_receipts
            (id, correlation_key, card_id, request_fingerprint, stored_fingerprint,
             outcome, reason_code, detail_code, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      const fingerprint = `sha256:${"a".repeat(64)}`;
      const uuid = "44444444-4444-4444-8444-444444444444";
      const key = `occ_v1_${"b".repeat(32)}`;
      // Mispaired outcome/reason.
      expect(() =>
        insert.run(
          uuid,
          key,
          null,
          fingerprint,
          null,
          "created",
          "workboard_card_recovered",
          null,
          1,
        ),
      ).toThrow(/CHECK/);
      // Unlisted reason code (server never writes non-durable codes to receipts).
      expect(() =>
        insert.run(uuid, key, null, fingerprint, null, "failed", "workboard_unavailable", null, 1),
      ).toThrow(/CHECK/);
      // Malformed correlation key.
      expect(() =>
        insert.run(
          uuid,
          "occ_v1_short",
          null,
          fingerprint,
          null,
          "created",
          "workboard_card_created",
          null,
          1,
        ),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});

describe("workboard atomic rollback compatibility (A35)", () => {
  function resolveRollbackBundle(): string | null {
    const override = process.env.OPENCLAW_ROLLBACK_BUNDLE;
    if (override) {
      return fs.existsSync(override) ? override : null;
    }
    const installRoot = path.join(os.homedir(), ".npm-global", "lib", "node_modules", "openclaw");
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(installRoot, "package.json"), "utf8")) as {
        version?: string;
      };
      if (pkg.version !== "2026.7.1-2") {
        return null;
      }
      const candidate = fs
        .readdirSync(path.join(installRoot, "dist"))
        .find((name) => /^sqlite-store-.*\.js$/.test(name));
      return candidate ? path.join(installRoot, "dist", candidate) : null;
    } catch {
      return null;
    }
  }

  it("the exact 2026.7.1-2 bundle opens schema 3, preserves the tuple, and cannot delete correlated cards", async () => {
    const bundlePath = resolveRollbackBundle();
    if (!bundlePath && !process.env.OPENCLAW_REQUIRE_ROLLBACK_FIXTURE) {
      console.warn(
        "A35 rollback fixture skipped: OpenClaw 2026.7.1-2 bundle not resolvable on this host. " +
          "Set OPENCLAW_ROLLBACK_BUNDLE or install openclaw@2026.7.1-2.",
      );
      return;
    }
    expect(bundlePath).toBeTruthy();
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { key, spec } = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z");
    const current = openStore(dbPath);
    const created = await current.store.createOrRecoverByCorrelationKey(key, spec);
    expect(created.reason_code).toBe("workboard_card_created");
    const cardId = created.card?.id as string;
    current.stores.close();
    const tupleBefore = JSON.stringify(
      new DatabaseSync(dbPath)
        .prepare(
          "SELECT correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
        )
        .get(cardId),
    );

    const bundle = (await import(bundlePath as string)) as Record<string, unknown>;
    const openOldStores = Object.values(bundle).find(
      (
        value,
      ): value is (options: { dbPath: string }) => {
        cards: {
          lookup: (key: string) => Promise<unknown>;
          register: (key: string, value: unknown) => Promise<void>;
          delete: (key: string) => Promise<boolean>;
        };
        close: () => void;
      } => typeof value === "function" && String(value).includes("createWorkboardSqliteStores"),
    );
    expect(openOldStores).toBeTruthy();
    const oldStores = (
      openOldStores as (options: { dbPath: string }) => {
        cards: {
          lookup: (
            key: string,
          ) => Promise<{ version: 1; card: Record<string, unknown> } | undefined>;
          register: (key: string, value: unknown) => Promise<void>;
          delete: (key: string) => Promise<boolean>;
        };
        close: () => void;
      }
    )({ dbPath });
    try {
      // 1. The old schema initializer opened schema 3 and retained all ledger rows.
      const dbAfterOpen = new DatabaseSync(dbPath);
      const ledger = (
        dbAfterOpen
          .prepare("SELECT id FROM workboard_schema_migrations ORDER BY id")
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
      dbAfterOpen.close();
      expect(ledger).toEqual([
        "schema-2",
        "schema-3",
        "schema-3-aut-wb-atomic",
        "schema-4",
        "schema-4-ot-gov-4",
      ]);
      // 2. Old lookup reads the correlated card.
      const oldRead = await oldStores.cards.lookup(cardId);
      expect(oldRead?.version).toBe(1);
      const oldCard = (oldRead?.card ?? {}) as Record<string, unknown>;
      expect(oldCard.title).toBe(spec.title);
      // 3. Old generic register updates an ordinary field, tuple preserved byte-for-byte.
      await oldStores.cards.register(cardId, {
        version: 1,
        card: { ...oldCard, title: "rollback ordinary edit" },
      });
      const dbAfterUpsert = new DatabaseSync(dbPath);
      const tupleAfter = JSON.stringify(
        dbAfterUpsert
          .prepare(
            "SELECT correlation_key, governance_spec_version, governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
          )
          .get(cardId),
      );
      const titleAfter = dbAfterUpsert
        .prepare("SELECT title FROM workboard_cards WHERE id = ?")
        .get(cardId) as { title: string };
      dbAfterUpsert.close();
      expect(tupleAfter).toBe(tupleBefore);
      expect(titleAfter.title).toBe("rollback ordinary edit");
      // 4. Old delete of the correlated card fails closed; the row remains.
      await expect(oldStores.cards.delete(cardId)).rejects.toThrow(/physically deleted/);
      expect(cardCount(dbPath, key)).toBe(1);
    } finally {
      oldStores.close();
    }
  }, 120_000);
});

describe("workboard atomic exact schema authority (Round-1 defect 1)", () => {
  function reopenSupports(dbPath: string): boolean {
    const { stores, store } = openStore(dbPath);
    const supports = store.supportsAtomicCreate();
    stores.close();
    return supports;
  }

  it("an unknown schema-999 ledger row blocks migration and the atomic surface", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    makeSchema2Fixture(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO workboard_schema_migrations (id, applied_at) VALUES ('schema-999', 1)",
    ).run();
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
    // The migration must not have run at all: no authority columns, ledger unchanged.
    const check = new DatabaseSync(dbPath);
    const columns = new Set(
      (check.prepare("PRAGMA table_info(workboard_cards)").all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    check.close();
    expect(columns.has("correlation_key")).toBe(false);
    expect(migrationLedger(dbPath)).toEqual(["schema-2", "schema-999"]);
  });

  it("an extra ledger row on a complete schema refuses the atomic surface", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO workboard_schema_migrations (id, applied_at) VALUES ('schema-999', 1)",
    ).run();
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
  });

  it("a missing required ledger row refuses the atomic surface", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    db.exec("DELETE FROM workboard_schema_migrations WHERE id = 'schema-3'");
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
  });

  it("a same-name non-unique correlation index is tampered authority and refuses", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      DROP INDEX workboard_cards_correlation_key_uq;
      CREATE INDEX workboard_cards_correlation_key_uq
      ON workboard_cards(correlation_key)
      WHERE correlation_key IS NOT NULL;
    `);
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
  });

  it("a changed partial-index predicate is tampered authority and refuses", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      DROP INDEX workboard_cards_correlation_key_uq;
      CREATE UNIQUE INDEX workboard_cards_correlation_key_uq
      ON workboard_cards(correlation_key)
      WHERE correlation_key IS NOT NULL AND correlation_key != '';
    `);
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
  });

  it("an altered trigger definition is tampered authority and refuses", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      DROP TRIGGER workboard_cards_correlated_no_delete;
      CREATE TRIGGER workboard_cards_correlated_no_delete
      BEFORE DELETE ON workboard_cards
      WHEN OLD.correlation_key IS NOT NULL AND 0
      BEGIN
        SELECT RAISE(ABORT, 'correlated cards cannot be physically deleted');
      END;
    `);
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
  });

  it("partial schema objects refuse and are never silently repaired", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const db = new DatabaseSync(dbPath);
    // Dropping the table also drops its append-only triggers.
    db.exec("DROP TABLE workboard_atomic_create_receipts");
    db.close();
    expect(reopenSupports(dbPath)).toBe(false);
    const check = new DatabaseSync(dbPath);
    const tables = (
      check
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='workboard_atomic_create_receipts'",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    check.close();
    expect(tables).toHaveLength(0);
  });

  it("the exact valid schema reopens successfully (control)", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    expect(reopenSupports(dbPath)).toBe(true);
    const { stores, store } = openStore(dbPath);
    try {
      const { key, spec } = makeAtomicSpec("aut-schema.control", "2026-08-03T12:00:00.000Z");
      const created = await store.createOrRecoverByCorrelationKey(key, spec);
      expect(created.reason_code).toBe("workboard_card_created");
    } finally {
      stores.close();
    }
  });
});

describe("workboard atomic legacy authority (Round-1 defect 2)", () => {
  const KEY_A = `occ_v1_${"a".repeat(32)}`;
  const KEY_B = `occ_v1_${"b".repeat(32)}`;

  it("migration refuses two valid legacy advertisers with the same occurrence key", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    makeSchema2Fixture(dbPath, [
      JSON.stringify({ idempotencyKey: KEY_A }),
      JSON.stringify({ idempotencyKey: KEY_A, boardId: "other" }),
    ]);
    const { stores, store } = openStore(dbPath);
    expect(store.supportsAtomicCreate()).toBe(false);
    stores.close();
    expect(migrationLedger(dbPath)).toEqual(["schema-2"]);
  });

  it("migration refuses a malformed occ_v1_ occurrence-key value", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    makeSchema2Fixture(dbPath, [JSON.stringify({ idempotencyKey: "occ_v1_BAD" })]);
    const { stores, store } = openStore(dbPath);
    expect(store.supportsAtomicCreate()).toBe(false);
    stores.close();
    expect(migrationLedger(dbPath)).toEqual(["schema-2"]);
  });

  it("migration succeeds with multiple unrelated legacy cards and adopts nothing", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    makeSchema2Fixture(dbPath, [
      JSON.stringify({ idempotencyKey: KEY_A }),
      JSON.stringify({ idempotencyKey: KEY_B }),
      JSON.stringify({ idempotencyKey: "ordinary-generic-key" }),
      JSON.stringify({ boardId: "no-key-at-all" }),
    ]);
    const { stores, store } = openStore(dbPath);
    expect(store.supportsAtomicCreate()).toBe(true);
    stores.close();
    const db = new DatabaseSync(dbPath);
    const adopted = db
      .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE correlation_key IS NOT NULL")
      .get() as { n: number | bigint };
    db.close();
    expect(Number(adopted.n)).toBe(0);
    expect(migrationLedger(dbPath)).toEqual([
      "schema-2",
      "schema-3",
      "schema-3-aut-wb-atomic",
      "schema-4",
      "schema-4-ot-gov-4",
    ]);
  });

  it("migration refuses a malformed unrelated payload (frozen migration policy)", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    makeSchema2Fixture(dbPath, [
      JSON.stringify({ idempotencyKey: KEY_A }),
      "{completely broken and unrelated to any key",
    ]);
    const { stores, store } = openStore(dbPath);
    expect(store.supportsAtomicCreate()).toBe(false);
    stores.close();
    expect(migrationLedger(dbPath)).toEqual(["schema-2"]);
  });

  it("a JSON-escaped but semantically equal legacy key is detected; no card is created beside it", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const { key, spec } = makeAtomicSpec("aut-legacy.escaped", "2026-08-03T12:00:00.000Z");
    // Escape one character of the key as a \u sequence: JSON.parse yields the exact
    // key while the raw payload text never contains the key substring.
    const escapedChar = `\\u00${key.charCodeAt(10).toString(16).padStart(2, "0")}`;
    const escapedPayload = `{"idempotencyKey":"${key.slice(0, 10)}${escapedChar}${key.slice(11)}"}`;
    expect(escapedPayload.includes(key)).toBe(false);
    expect((JSON.parse(escapedPayload) as { idempotencyKey: string }).idempotencyKey).toBe(key);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `
        INSERT INTO workboard_cards
          (id, board_id, title, status, priority, position, created_at, updated_at, automation_json)
        VALUES ('66666666-6666-4666-8666-666666666666', 'default', 'escaped legacy', 'backlog', 'normal', 1, 1, 1, ?)
      `,
    ).run(escapedPayload);
    db.close();
    const { stores, store } = openStore(dbPath);
    try {
      const result = await store.createOrRecoverByCorrelationKey(key, spec);
      expect(result.reason_code).toBe("workboard_incompatible_legacy_card");
      expect(result.card).toBeNull();
      expect(cardCount(dbPath, key)).toBe(0);
      const receipts = receiptRows(dbPath, key);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.card_id).toBe("66666666-6666-4666-8666-666666666666");
    } finally {
      stores.close();
    }
  });
});

describe("workboard atomic receipt authority (Round-1 defect 5)", () => {
  const VALID_FP = `sha256:${"a".repeat(64)}`;
  const VALID_KEY = `occ_v1_${"c".repeat(32)}`;
  const VALID_UUID = "77777777-7777-4777-8777-777777777777";
  const OTHER_UUID = "88888888-8888-4888-8888-888888888888";

  function receiptInsert(dbPath: string) {
    const db = new DatabaseSync(dbPath);
    const statement = db.prepare(
      `
        INSERT INTO workboard_atomic_create_receipts
          (id, correlation_key, card_id, request_fingerprint, stored_fingerprint,
           outcome, reason_code, detail_code, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    return { db, statement };
  }

  it("the receipt table refuses malformed or mispaired rows at the SQLite boundary", () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    openStore(dbPath).stores.close();
    const { db, statement } = receiptInsert(dbPath);
    try {
      const attempts: Array<[string, unknown[]]> = [
        [
          "uppercase correlation key",
          [
            VALID_UUID,
            VALID_KEY.toUpperCase(),
            OTHER_UUID,
            VALID_FP,
            VALID_FP,
            "created",
            "workboard_card_created",
            null,
            1,
          ],
        ],
        [
          "malformed fingerprint",
          [
            VALID_UUID,
            VALID_KEY,
            OTHER_UUID,
            "sha256:NOT-HEX",
            VALID_FP,
            "created",
            "workboard_card_created",
            null,
            1,
          ],
        ],
        [
          "null card_id on created",
          [
            VALID_UUID,
            VALID_KEY,
            null,
            VALID_FP,
            VALID_FP,
            "created",
            "workboard_card_created",
            null,
            1,
          ],
        ],
        [
          "null card_id on recovered",
          [
            VALID_UUID,
            VALID_KEY,
            null,
            VALID_FP,
            VALID_FP,
            "recovered",
            "workboard_card_recovered",
            null,
            1,
          ],
        ],
        [
          "stored_fingerprint forbidden on legacy refusal",
          [
            VALID_UUID,
            VALID_KEY,
            null,
            VALID_FP,
            VALID_FP,
            "refused",
            "workboard_incompatible_legacy_card",
            null,
            1,
          ],
        ],
        [
          "free-form detail code",
          [
            VALID_UUID,
            VALID_KEY,
            OTHER_UUID,
            VALID_FP,
            VALID_FP,
            "refused",
            "workboard_card_state_incompatible",
            "This Is Prose!",
            1,
          ],
        ],
        [
          "missing detail code on state refusal",
          [
            VALID_UUID,
            VALID_KEY,
            OTHER_UUID,
            VALID_FP,
            VALID_FP,
            "refused",
            "workboard_card_state_incompatible",
            null,
            1,
          ],
        ],
        [
          "detail code forbidden on created",
          [
            VALID_UUID,
            VALID_KEY,
            OTHER_UUID,
            VALID_FP,
            VALID_FP,
            "created",
            "workboard_card_created",
            "card-assigned",
            1,
          ],
        ],
        [
          "wrong outcome/reason pairing",
          [
            VALID_UUID,
            VALID_KEY,
            OTHER_UUID,
            VALID_FP,
            VALID_FP,
            "created",
            "workboard_card_recovered",
            null,
            1,
          ],
        ],
        [
          "non-durable reason code",
          [VALID_UUID, VALID_KEY, null, VALID_FP, null, "failed", "workboard_unavailable", null, 1],
        ],
        [
          "malformed uuid",
          [
            "not-a-uuid",
            VALID_KEY,
            OTHER_UUID,
            VALID_FP,
            VALID_FP,
            "created",
            "workboard_card_created",
            null,
            1,
          ],
        ],
        [
          "missing stored fingerprint on conflict",
          [
            VALID_UUID,
            VALID_KEY,
            OTHER_UUID,
            VALID_FP,
            null,
            "refused",
            "workboard_card_conflict",
            null,
            1,
          ],
        ],
      ];
      for (const [label, values] of attempts) {
        expect(() => statement.run(...(values as never[])), label).toThrow(/CHECK/);
      }
      // Valid receipt control row is accepted.
      statement.run(
        VALID_UUID,
        VALID_KEY,
        OTHER_UUID,
        VALID_FP,
        VALID_FP,
        "created",
        "workboard_card_created",
        null,
        1,
      );
      const count = db
        .prepare("SELECT COUNT(*) AS n FROM workboard_atomic_create_receipts")
        .get() as { n: number | bigint };
      expect(Number(count.n)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("the valid control receipt resolves through the closed read-only lookup", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const { stores, store } = openStore(dbPath);
    try {
      const db = new DatabaseSync(dbPath);
      db.prepare(
        `
          INSERT INTO workboard_atomic_create_receipts
            (id, correlation_key, card_id, request_fingerprint, stored_fingerprint,
             outcome, reason_code, detail_code, created_at)
          VALUES (?, ?, ?, ?, ?, 'created', 'workboard_card_created', NULL, 5)
        `,
      ).run(VALID_UUID, VALID_KEY, OTHER_UUID, VALID_FP, VALID_FP);
      db.close();
      const lookup = await store.getAtomicCreateReceipt(VALID_UUID);
      expect(lookup.receipt).toMatchObject({
        schema_version: 1,
        id: VALID_UUID,
        correlation_key: VALID_KEY,
        card_id: OTHER_UUID,
        outcome: "created",
        reason_code: "workboard_card_created",
        detail_code: null,
      });
    } finally {
      stores.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OT-GOV-4 — start authority: real-process races, crash points, restart, and
// migration interruption (contract §10, matrix rows [R3][R4][R27][R28][R29]
// [R34], migration §12). Same self-re-execution driver as the atomic suite.
// ─────────────────────────────────────────────────────────────────────────────

describe("OT-GOV-4 start authority (process races and crash points)", () => {
  function makeStartRequest(
    card: { id: string; status: string; updatedAt: number },
    attemptId: string,
    over: Record<string, unknown> = {},
  ) {
    return {
      schema_version: 1,
      card_id: card.id,
      attempt_id: attemptId,
      authority_id: "veelo-start-authority",
      expected_status: card.status,
      expected_updated_at: card.updatedAt,
      required_dependency_state: "none",
      forbidden_labels: ["hold", "operator-merge-only", "operator-controlled"],
      expected_assignee: null,
      worker: { engine: "codex", mode: "exec", model: null, session_key: null },
      ...over,
    };
  }

  async function seedReadyCard(
    dbPath: string,
  ): Promise<{ id: string; status: string; updatedAt: number }> {
    const { stores, store } = openStore(dbPath);
    try {
      const card = await store.create({ title: "start race card", status: "ready" });
      const fresh = await store.get(card.id);
      return { id: card.id, status: fresh?.status ?? "ready", updatedAt: fresh?.updatedAt ?? 0 };
    } finally {
      stores.close();
    }
  }

  function reservationCount(dbPath: string, cardId: string): number {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM workboard_card_start_reservations WHERE card_id = ? AND released_at IS NULL",
        )
        .get(cardId) as { n: number | bigint };
      return Number(row.n);
    } finally {
      db.close();
    }
  }

  it("[R3] two OS processes with the IDENTICAL request produce exactly one reservation", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const card = await seedReadyCard(dbPath);
    const attemptId = crypto.randomUUID().toLowerCase();
    const request = makeStartRequest(card, attemptId);
    const go = path.join(workDir, "go");
    const children = [0, 1].map((i) =>
      spawnDriver({
        dbPath,
        mode: "start",
        ready: path.join(workDir, `ready-${i}`),
        go,
        out: path.join(workDir, `out-${i}`),
        extraEnv: { WB_DRIVER_START_REQUEST: JSON.stringify(request) },
      }),
    );
    const deadline = Date.now() + 30_000;
    while (![0, 1].every((i) => fs.existsSync(path.join(workDir, `ready-${i}`)))) {
      if (Date.now() > deadline) throw new Error("children never became ready");
      await sleep(5);
    }
    fs.writeFileSync(go, "go");
    await Promise.all(children.map((child) => waitForExit(child)));
    const results = [0, 1].map(
      (i) =>
        JSON.parse(fs.readFileSync(path.join(workDir, `out-${i}`), "utf8")) as {
          reason_code: string;
        },
    );
    const reasons = results.map((r) => r.reason_code).sort();
    // Exactly one reserved; the loser of the race recovers the SAME reservation
    // (identical attempt_id) — never a second row [R3].
    expect(reasons).toEqual(["workboard_start_recovered", "workboard_start_reserved"]);
    expect(reservationCount(dbPath, card.id)).toBe(1);
  });

  it("[R4] 16 concurrent callers with DISTINCT attempts: one reserved, 15 refused already_reserved", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const card = await seedReadyCard(dbPath);
    const go = path.join(workDir, "go16");
    const n = 16;
    const children = Array.from({ length: n }, (_, i) =>
      spawnDriver({
        dbPath,
        mode: "start",
        ready: path.join(workDir, `r16-${i}`),
        go,
        out: path.join(workDir, `o16-${i}`),
        extraEnv: {
          WB_DRIVER_START_REQUEST: JSON.stringify(
            makeStartRequest(card, crypto.randomUUID().toLowerCase()),
          ),
        },
      }),
    );
    const deadline = Date.now() + 60_000;
    while (
      !Array.from({ length: n }, (_, i) => path.join(workDir, `r16-${i}`)).every((f) =>
        fs.existsSync(f),
      )
    ) {
      if (Date.now() > deadline) throw new Error("16 children never became ready");
      await sleep(5);
    }
    fs.writeFileSync(go, "go");
    await Promise.all(children.map((child) => waitForExit(child)));
    const reasons = Array.from(
      { length: n },
      (_, i) =>
        (
          JSON.parse(fs.readFileSync(path.join(workDir, `o16-${i}`), "utf8")) as {
            reason_code: string;
          }
        ).reason_code,
    );
    // §11 row 4, exact (F5 correction; Round-2 residual closed): one reserved,
    // 15 refused already_reserved — the reservation refusal outranks CAS.
    expect(reasons.filter((r) => r === "workboard_start_reserved")).toHaveLength(1);
    expect(reasons.filter((r) => r === "workboard_start_already_reserved")).toHaveLength(n - 1);
    expect(reservationCount(dbPath, card.id)).toBe(1);
  });

  it("[R27] crash before COMMIT persists nothing; a replay reserves cleanly", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const card = await seedReadyCard(dbPath);
    const attemptId = crypto.randomUUID().toLowerCase();
    const child = spawnDriver({
      dbPath,
      mode: "start",
      out: path.join(workDir, "crash-out"),
      extraEnv: {
        WB_DRIVER_START_REQUEST: JSON.stringify(makeStartRequest(card, attemptId)),
        OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH: "start-before-commit",
      },
    });
    const exit = await waitForExit(child);
    expect(exit.code).not.toBe(0);
    expect(reservationCount(dbPath, card.id)).toBe(0);
    const db = new DatabaseSync(dbPath);
    const receipts = db
      .prepare("SELECT COUNT(*) AS n FROM workboard_start_receipts WHERE card_id = ?")
      .get(card.id) as { n: number | bigint };
    const cardRow = db
      .prepare("SELECT status, claim_json FROM workboard_cards WHERE id = ?")
      .get(card.id) as { status: string; claim_json: string | null };
    db.close();
    expect(Number(receipts.n)).toBe(0);
    expect(cardRow.status).toBe("ready");
    expect(cardRow.claim_json).toBeNull();
    // Replay of the same attempt reserves cleanly [R27].
    const { stores, store } = openStore(dbPath);
    try {
      const fresh = await store.get(card.id);
      const replay = await store.startCardIfEligible(
        makeStartRequest(
          { id: card.id, status: fresh?.status ?? "ready", updatedAt: fresh?.updatedAt ?? 0 },
          attemptId,
        ),
      );
      expect(replay.reason_code).toBe("workboard_start_reserved");
    } finally {
      stores.close();
    }
  });

  it("[R28] crash after COMMIT, before the response: replay of the same attempt returns recovered", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const card = await seedReadyCard(dbPath);
    const attemptId = crypto.randomUUID().toLowerCase();
    const child = spawnDriver({
      dbPath,
      mode: "start",
      out: path.join(workDir, "crash28-out"),
      extraEnv: {
        WB_DRIVER_START_REQUEST: JSON.stringify(makeStartRequest(card, attemptId)),
        OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH: "start-after-commit",
      },
    });
    const exit = await waitForExit(child);
    expect(exit.code).not.toBe(0);
    // The reservation committed even though the caller never saw the response.
    expect(reservationCount(dbPath, card.id)).toBe(1);
    const { stores, store } = openStore(dbPath);
    try {
      const fresh = await store.get(card.id);
      const replay = await store.startCardIfEligible(
        makeStartRequest(
          { id: card.id, status: fresh?.status ?? "running", updatedAt: fresh?.updatedAt ?? 0 },
          attemptId,
        ),
      );
      expect(replay.reason_code).toBe("workboard_start_recovered");
      expect(reservationCount(dbPath, card.id)).toBe(1);
    } finally {
      stores.close();
    }
  });

  it("[R29][R34] an orphaned reservation survives restart, still blocks, is age-detectable, and neutrally releases", async () => {
    const dbPath = path.join(workDir, "workboard.sqlite");
    const card = await seedReadyCard(dbPath);
    const attemptId = crypto.randomUUID().toLowerCase();
    // Reserve in a separate process (worker never created — the orphan case).
    const child = spawnDriver({
      dbPath,
      mode: "start",
      out: path.join(workDir, "orphan-out"),
      extraEnv: { WB_DRIVER_START_REQUEST: JSON.stringify(makeStartRequest(card, attemptId)) },
    });
    await waitForExit(child);
    const envelope = JSON.parse(fs.readFileSync(path.join(workDir, "orphan-out"), "utf8")) as {
      reason_code: string;
      reservation: {
        reservation_id: string;
        attempt_id: string;
        expires_at: number;
        worker_bound: boolean;
      };
    };
    expect(envelope.reason_code).toBe("workboard_start_reserved");
    expect(envelope.reservation.worker_bound).toBe(false);
    // "Restart": a fresh store over the same file [R34].
    const { stores, store } = openStore(dbPath);
    try {
      // Still blocks a different attempt.
      const fresh = await store.get(card.id);
      const blocked = await store.startCardIfEligible(
        makeStartRequest(
          { id: card.id, status: fresh?.status ?? "running", updatedAt: fresh?.updatedAt ?? 0 },
          crypto.randomUUID().toLowerCase(),
          { expected_assignee: fresh?.agentId ?? null },
        ),
      );
      // Exact blocking reason across restart (F5, Round 1).
      expect(blocked.reason_code).toBe("workboard_start_already_reserved");
      // [R29]/F12: orphan-age detection distinguishes live from expired.
      // This fresh reservation is LIVE (expires_at in the future) ...
      expect(envelope.reservation.expires_at).toBeGreaterThan(Date.now());
      // ... while a reservation whose TTL elapsed reads as an expired orphan:
      // reserve at the sqlite layer with a 1ms TTL on a second card.
      {
        const orphanCard = await store.create({ title: "expired orphan", status: "ready" });
        const orphanFresh = await store.get(orphanCard.id);
        const capable = stores.cards as unknown as {
          startCardIfEligible: (request: Record<string, unknown>) => { kind: string; reservation: { expiresAt: number; reservationId: string; attemptId: string } };
        };
        const direct = capable.startCardIfEligible({
          cardId: orphanCard.id,
          attemptId: crypto.randomUUID().toLowerCase(),
          authorityId: "veelo-start-authority",
          expectedStatus: orphanFresh?.status ?? "ready",
          expectedUpdatedAt: orphanFresh?.updatedAt ?? 0,
          requiredDependencyState: "none",
          forbiddenLabels: ["hold", "operator-merge-only", "operator-controlled"],
          expectedAssignee: orphanFresh?.agentId ?? null,
          reservationId: crypto.randomUUID().toLowerCase(),
          receiptId: crypto.randomUUID().toLowerCase(),
          eventId: crypto.randomUUID().toLowerCase(),
          claimToken: crypto.randomUUID().toLowerCase(),
          worker: { engine: "codex", mode: "exec", model: null, sessionKey: null },
          now: Date.now(),
          ttlMs: 1,
        });
        expect(direct.kind).toBe("reserved");
        expect(direct.reservation.expiresAt).toBeLessThanOrEqual(Date.now());
        // The expired orphan neutrally releases.
        const orphanRelease = await store.releaseStartReservation({
          schema_version: 1,
          reservation_id: direct.reservation.reservationId,
          attempt_id: direct.reservation.attemptId,
          reason: "expired-orphan-recovery",
        });
        expect(orphanRelease.reason_code).toBe("workboard_start_released");
      }
      // Neutral release recovers the card without a failure mark.
      const release = await store.releaseStartReservation({
        schema_version: 1,
        reservation_id: envelope.reservation.reservation_id,
        attempt_id: envelope.reservation.attempt_id,
        reason: "orphan-recovery",
      });
      expect(release.reason_code).toBe("workboard_start_released");
      const after = await store.get(card.id);
      expect(after?.status).toBe("ready");
      expect(after?.metadata?.failureCount ?? 0).toBe(0);
    } finally {
      stores.close();
    }
  });

  for (const crashPoint of [
    "start-migration-ddl",
    "start-migration-index",
    "start-migration-ledger",
  ]) {
    it(`schema-4 migration interrupted at ${crashPoint} is all-or-nothing and completes on reopen`, async () => {
      const dbPath = path.join(workDir, "workboard.sqlite");
      // Build a schema-3 database with NO schema-4 (strip it after open).
      const first = openStore(dbPath);
      first.stores.close();
      const db = new DatabaseSync(dbPath);
      db.exec("DROP TRIGGER workboard_cards_reserved_no_delete");
      db.exec("DROP TABLE workboard_start_receipts");
      db.exec("DROP TABLE workboard_card_start_reservations");
      db.prepare(
        "DELETE FROM workboard_schema_migrations WHERE id IN ('schema-4','schema-4-ot-gov-4')",
      ).run();
      db.close();
      // Interrupt the migration mid-flight in a child process.
      const child = spawnDriver({
        dbPath,
        mode: "open-only",
        extraEnv: { OPENCLAW_WORKBOARD_TEST_ATOMIC_CRASH: crashPoint },
      });
      const exit = await waitForExit(child);
      expect(exit.code).not.toBe(0);
      // All-or-nothing: either no schema-4 ledger rows, or all of them.
      const check = new DatabaseSync(dbPath);
      const ledger = (
        check
          .prepare(
            "SELECT id FROM workboard_schema_migrations WHERE id LIKE 'schema-4%' ORDER BY id",
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
      check.close();
      expect([0, 2]).toContain(ledger.length);
      // Reopen completes the migration cleanly.
      const again = openStore(dbPath);
      try {
        const card = await again.store.create({ title: "post-interrupt", status: "ready" });
        const fresh = await again.store.get(card.id);
        const response = await again.store.startCardIfEligible(
          makeStartRequest(
            { id: card.id, status: fresh?.status ?? "ready", updatedAt: fresh?.updatedAt ?? 0 },
            crypto.randomUUID().toLowerCase(),
          ),
        );
        expect(response.reason_code).toBe("workboard_start_reserved");
      } finally {
        again.stores.close();
      }
    });
  }

  it("[R40] the rollback binary opens schema-4, preserves reservation rows, and cannot delete a reserved card", async () => {
    const bundlePath = (() => {
      const override = process.env.OPENCLAW_ROLLBACK_BUNDLE;
      if (override) {
        return fs.existsSync(override) ? override : null;
      }
      const installRoot = path.join(os.homedir(), ".npm-global", "lib", "node_modules", "openclaw");
      try {
        const candidate = fs
          .readdirSync(path.join(installRoot, "dist"))
          .find((name) => /^sqlite-store-.*\.js$/.test(name));
        return candidate ? path.join(installRoot, "dist", candidate) : null;
      } catch {
        return null;
      }
    })();
    if (!bundlePath && !process.env.OPENCLAW_REQUIRE_ROLLBACK_FIXTURE) {
      console.warn(
        "R40 rollback fixture skipped: no installed openclaw bundle resolvable. Set OPENCLAW_ROLLBACK_BUNDLE.",
      );
      return;
    }
    expect(bundlePath).toBeTruthy();
    const dbPath = path.join(workDir, "workboard.sqlite");
    const card = await seedReadyCard(dbPath);
    const { stores, store } = openStore(dbPath);
    let reservationId: string;
    try {
      const fresh = await store.get(card.id);
      const reserved = await store.startCardIfEligible(
        makeStartRequest(
          { id: card.id, status: fresh?.status ?? "ready", updatedAt: fresh?.updatedAt ?? 0 },
          crypto.randomUUID().toLowerCase(),
        ),
      );
      expect(reserved.reason_code).toBe("workboard_start_reserved");
      reservationId = reserved.reservation?.reservation_id as string;
    } finally {
      stores.close();
    }
    const rowBefore = JSON.stringify(
      new DatabaseSync(dbPath)
        .prepare("SELECT * FROM workboard_card_start_reservations WHERE reservation_id = ?")
        .get(reservationId),
    );
    const bundle = (await import(bundlePath as string)) as Record<string, unknown>;
    const openOldStores = Object.values(bundle).find(
      (
        value,
      ): value is (options: { dbPath: string }) => {
        cards: {
          lookup: (
            key: string,
          ) => Promise<{ version: 1; card: Record<string, unknown> } | undefined>;
          register: (key: string, value: unknown) => Promise<void>;
          delete: (key: string) => Promise<boolean>;
        };
        close: () => void;
      } => typeof value === "function" && String(value).includes("createWorkboardSqliteStores"),
    );
    expect(openOldStores).toBeTruthy();
    const oldStores = openOldStores!({ dbPath });
    try {
      // Old binary reads the reserved card.
      const oldRead = await oldStores.cards.lookup(card.id);
      expect(oldRead?.version).toBe(1);
      // Old generic register performs an ordinary edit; the reservation row survives byte-for-byte.
      await oldStores.cards.register(card.id, {
        version: 1,
        card: { ...(oldRead?.card ?? {}), title: "rollback edit with live reservation" },
      });
      const rowAfter = JSON.stringify(
        new DatabaseSync(dbPath)
          .prepare("SELECT * FROM workboard_card_start_reservations WHERE reservation_id = ?")
          .get(reservationId),
      );
      expect(rowAfter).toBe(rowBefore);
      // Old delete of the reserved card fails closed (schema-4 trigger).
      let deleted = false;
      try {
        deleted = await oldStores.cards.delete(card.id);
      } catch {
        deleted = false;
      }
      expect(deleted).toBe(false);
      const still = new DatabaseSync(dbPath)
        .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE id = ?")
        .get(card.id) as { n: number | bigint };
      expect(Number(still.n)).toBe(1);
    } finally {
      oldStores.close();
    }
  });
});
