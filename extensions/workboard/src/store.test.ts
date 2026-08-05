// Workboard tests cover store plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import {
  WorkboardStore,
  type PersistedWorkboardAttachment,
  type PersistedWorkboardBoard,
  type PersistedWorkboardCard,
  type PersistedWorkboardNotificationSubscription,
  type WorkboardKeyedStore,
} from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(options?: {
  beforeRegister?: (key: string, value: T) => Promise<void> | void;
}): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      await options?.beforeRegister?.(key, value);
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function statfsFixture(type: number): ReturnType<typeof fs.statfsSync> {
  return {
    type,
    bsize: 1024,
    blocks: 1,
    bfree: 1,
    bavail: 1,
    files: 0,
    frsize: 1024,
    ffree: 0,
  };
}

describe("WorkboardStore", () => {
  it("persists boards, cards, subscriptions, and attachment blobs in sqlite", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-sqlite-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    if (process.platform !== "win32") {
      fs.chmodSync(dir, 0o755);
    }
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const board = await store.upsertBoard({ id: "planning", name: "Planning" });
      const card = await store.create({
        title: "Persist it",
        boardId: board.id,
        labels: ["sqlite", "doctor"],
        execution: {
          id: "exec-1",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "gpt-5.5",
          sessionKey: "agent:main:test",
          runId: "run-1",
          startedAt: 1,
          updatedAt: 2,
        },
      });
      await store.addComment(card.id, { body: "round trip" });
      const attached = await store.addAttachment(card.id, {
        fileName: "proof.txt",
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      expect(attached.events?.at(-1)).toMatchObject({ kind: "attachment_added" });
      await store.addAttachment(card.id, {
        fileName: "large-proof.bin",
        contentBase64: Buffer.alloc(70 * 1024).toString("base64"),
      });
      await store.update(card.id, {
        metadata: { lifecycleStatusSourceUpdatedAt: 1234 },
      });
      const attachmentId = attached.metadata?.attachments?.[0]?.id;
      const subscription = await store.subscribeNotifications({
        boardId: board.id,
        target: "agent:main:test",
        eventKinds: ["completed"],
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
        for (const sidecarPath of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
          if (fs.existsSync(sidecarPath)) {
            expect(fs.statSync(sidecarPath).mode & 0o777).toBe(0o600);
          }
        }
      }
      stores.close();

      const rawDb = new DatabaseSync(dbPath);
      expect(rawDb.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "wal",
      });
      rawDb.close();

      const reopenedStores = createWorkboardSqliteStores({ dbPath });
      const reopened = new WorkboardStore(reopenedStores.cards, {
        boards: reopenedStores.boards,
        subscriptions: reopenedStores.subscriptions,
        attachments: reopenedStores.attachments,
      });

      expect(await reopened.listBoards()).toMatchObject({
        boards: [
          expect.objectContaining({ id: "default" }),
          expect.objectContaining({ id: board.id, name: "Planning" }),
        ],
      });
      expect(await reopened.get(card.id)).toMatchObject({
        id: card.id,
        labels: ["sqlite", "doctor"],
        metadata: {
          automation: { boardId: "planning" },
          lifecycleStatusSourceUpdatedAt: 1234,
          comments: [expect.objectContaining({ body: "round trip" })],
          attachments: expect.arrayContaining([
            expect.objectContaining({ fileName: "proof.txt" }),
            expect.objectContaining({ fileName: "large-proof.bin" }),
          ]),
        },
      });
      expect(await reopened.getAttachment(attachmentId ?? "")).toMatchObject({
        contentBase64: Buffer.from("ok").toString("base64"),
      });
      await reopened.delete(card.id);
      expect(await reopened.getAttachment(attachmentId ?? "")).toBeUndefined();
      expect(await reopened.listNotificationSubscriptions({ boardId: board.id })).toMatchObject({
        subscriptions: [expect.objectContaining({ id: subscription.id })],
      });
      reopenedStores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses rollback journaling on network-backed volumes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-sqlite-network-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue(statfsFixture(0xff534d42));
    try {
      const stores = createWorkboardSqliteStores({ dbPath });
      stores.close();

      const rawDb = new DatabaseSync(dbPath);
      expect(rawDb.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "delete",
      });
      rawDb.close();
      expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    } finally {
      statfs.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates and lists cards by status order and position", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const review = await store.create({
      title: "Review release notes",
      status: "review",
      priority: "high",
      labels: "release, docs",
    });
    const todo = await store.create({ title: "Fix dashboard copy", status: "todo" });

    expect((await store.list()).map((card) => card.id)).toEqual([todo.id, review.id]);
    expect(review.labels).toEqual(["release", "docs"]);
    expect(review.priority).toBe("high");
    expect(review.events?.[0]).toMatchObject({ kind: "created", toStatus: "review" });
  });

  it("does not persist empty metadata for default cards", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const card = await store.create({ title: "Plain card" });

    expect(card.metadata).toBeUndefined();
    const entry = await keyed.lookup(card.id);
    expect(Object.hasOwn(entry?.card ?? {}, "metadata")).toBe(false);
  });

  it("preserves explicit zero positions", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const card = await store.create({ title: "Top card", status: "todo", position: 0 });

    expect(card.position).toBe(0);
  });

  it("keeps initial session, run, and task links when creating cards", async () => {
    const store = new WorkboardStore(createMemoryStore());

    const card = await store.create({
      title: "Follow up",
      sessionKey: "agent:main:dashboard:1",
      runId: "run-1",
      taskId: "task-1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "claude",
        mode: "manual",
        status: "running",
        model: "anthropic/claude-sonnet-4-6",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    expect(card).toMatchObject({
      sessionKey: "agent:main:dashboard:1",
      runId: "run-1",
      taskId: "task-1",
      execution: {
        engine: "claude",
        mode: "manual",
        model: "anthropic/claude-sonnet-4-6",
      },
      metadata: {
        attempts: [
          expect.objectContaining({
            id: "agent:main:dashboard:1",
            status: "running",
            engine: "claude",
            mode: "manual",
            sessionKey: "agent:main:dashboard:1",
            startedAt: 10,
          }),
        ],
      },
    });
  });

  it("ignores dependency links from generic metadata writes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent" });
    const child = await store.create({
      title: "Child",
      metadata: {
        links: [{ id: "raw-parent", type: "parent", targetCardId: parent.id, createdAt: 1 }],
      },
    });

    expect(child.metadata?.links).toBeUndefined();

    const updated = await store.update(child.id, {
      metadata: {
        links: [{ id: "raw-parent-2", type: "parent", targetCardId: parent.id, createdAt: 2 }],
      },
    });
    expect(updated.metadata?.links).toBeUndefined();
  });

  it("stores card templates and metadata in the card record", async () => {
    const keyed = createMemoryStore();
    const store = new WorkboardStore(keyed);

    const card = await store.create({
      title: "Fix flaky lane",
      templateId: "bugfix",
      metadata: {
        comments: [{ id: "comment-1", body: "Seen twice", createdAt: 10 }],
        links: [{ id: "link-1", type: "blocks", targetCardId: "card-2", createdAt: 11 }],
        proof: [{ id: "proof-1", status: "passed", command: "pnpm test", createdAt: 12 }],
      },
    });

    await expect(keyed.lookup(card.id)).resolves.toMatchObject({
      version: 1,
      card: {
        metadata: {
          templateId: "bugfix",
          comments: [expect.objectContaining({ body: "Seen twice" })],
          links: [expect.objectContaining({ type: "blocks", targetCardId: "card-2" })],
          proof: [expect.objectContaining({ status: "passed", command: "pnpm test" })],
        },
      },
    });
  });

  it("updates automation metadata from top-level patch fields", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Tune automation" });

    const updated = await store.update(card.id, {
      tenant: "release",
      idempotencyKey: "release:1",
      skills: ["testing", "docs"],
      workspace: { kind: "scratch" },
      maxRuntimeSeconds: 120,
      maxRetries: 2,
      scheduledAt: 10_000,
    });

    expect(updated.metadata?.automation).toMatchObject({
      tenant: "release",
      idempotencyKey: "release:1",
      skills: ["testing", "docs"],
      workspace: { kind: "scratch" },
      maxRuntimeSeconds: 120,
      maxRetries: 2,
      scheduledAt: 10_000,
    });

    const cleared = await store.update(card.id, { scheduledAt: null });
    expect(cleared.metadata?.automation?.scheduledAt).toBeUndefined();
    expect(cleared.metadata?.automation).toMatchObject({
      tenant: "release",
      maxRetries: 2,
    });

    const preserved = await store.update(card.id, {
      scheduledAt: 20_000,
      maxRuntimeSeconds: undefined,
    });
    expect(preserved.metadata?.automation).toMatchObject({
      scheduledAt: 20_000,
      maxRuntimeSeconds: 120,
    });
  });

  it("moves cards and records lifecycle timestamps", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Ship workboard" });

    const running = await store.move(card.id, "running", 500);
    expect(running.status).toBe("running");
    expect(running.position).toBe(500);
    expect(running.startedAt).toBeGreaterThanOrEqual(card.createdAt);
    expect(running.events?.at(-1)).toMatchObject({
      kind: "moved",
      fromStatus: "todo",
      toStatus: "running",
    });

    const done = await store.update(card.id, { status: "done" });
    expect(done.completedAt).toBeGreaterThanOrEqual(done.startedAt ?? 0);

    const rolledBack = await store.update(card.id, {
      status: "todo",
      startedAt: null,
      completedAt: null,
    });
    expect(rolledBack.startedAt).toBeUndefined();
    expect(rolledBack.completedAt).toBeUndefined();
  });

  it("tracks lifecycle status provenance and clears it on manual status changes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Sync status provenance" });

    const zeroSourceLifecycle = await store.update(card.id, {
      status: "running",
      metadata: { lifecycleStatusSourceUpdatedAt: 0 },
    });
    expect(zeroSourceLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(0);

    const lifecycleMoved = await store.update(card.id, {
      status: "running",
      metadata: { lifecycleStatusSourceUpdatedAt: 1000 },
    });
    expect(lifecycleMoved.metadata?.lifecycleStatusSourceUpdatedAt).toBe(1000);

    const newerLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 3000 },
    });
    expect(newerLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(3000);

    const manual = await store.move(card.id, "running", 2000);
    expect(manual.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const staleZeroLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 0 },
    });
    expect(staleZeroLifecycle).toEqual(manual);
    expect(staleZeroLifecycle.status).toBe("running");
    expect(staleZeroLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const staleLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
    });
    expect(staleLifecycle).toEqual(manual);
    expect(staleLifecycle.status).toBe("running");
    expect(staleLifecycle.updatedAt).toBe(manual.updatedAt);
    expect(staleLifecycle.events).toHaveLength(manual.events?.length ?? 0);
    expect(staleLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const freshLifecycleSourceUpdatedAt = Date.now() + 1000;
    const freshLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: freshLifecycleSourceUpdatedAt },
    });
    expect(freshLifecycle.status).toBe("review");
    expect(freshLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(
      freshLifecycleSourceUpdatedAt,
    );
  });

  it("keeps creation status from stale lifecycle patches", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(2000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Initial running status",
        status: "running",
      });

      const staleLifecycle = await store.update(card.id, {
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 1000 },
      });
      expect(staleLifecycle).toEqual(card);
      expect(staleLifecycle.status).toBe("running");
      expect(staleLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

      const freshLifecycle = await store.update(card.id, {
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 3000 },
      });
      expect(freshLifecycle.status).toBe("review");
      expect(freshLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBe(3000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let one stale bulk lifecycle patch strip later card updates", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const store = new WorkboardStore(createMemoryStore());
      const staleCard = await store.create({ title: "Stale bulk target" });
      const freshCard = await store.create({ title: "Fresh bulk target" });
      vi.setSystemTime(3000);
      await store.move(staleCard.id, "running", 1000);

      const patch = {
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
      } as const;
      const result = await store.bulkUpdate({
        ids: [staleCard.id, freshCard.id],
        patch,
      });

      expect(result.cards[0]).toMatchObject({ id: staleCard.id, status: "running" });
      expect(result.cards[0]?.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
      expect(result.cards[1]).toMatchObject({ id: freshCard.id, status: "review" });
      expect(result.cards[1]?.metadata?.lifecycleStatusSourceUpdatedAt).toBe(2000);
      expect(patch).toEqual({
        status: "review",
        metadata: { lifecycleStatusSourceUpdatedAt: 2000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps non-status fields from stale lifecycle patches", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Keep stale sync details",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 1,
        updatedAt: 1000,
      },
    });
    const lifecycleMoved = await store.update(card.id, {
      status: "review",
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: {
          detectedAt: 1000,
          lastSessionUpdatedAt: 1000,
          reason: "Session has not reported recent activity.",
        },
      },
    });
    const manual = await store.update(card.id, {
      status: "running",
      metadata: lifecycleMoved.metadata,
    });

    const synced = await store.update(card.id, {
      status: "review",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "done",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 1,
        updatedAt: 2000,
      },
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: null,
      },
    });

    expect(manual.metadata?.stale).toBeDefined();
    expect(synced.status).toBe("running");
    expect(synced.execution).toMatchObject({
      runId: "run-1",
      status: "done",
      updatedAt: 2000,
    });
    expect(synced.metadata?.stale).toBeUndefined();
    expect(synced.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
    expect(synced.events?.at(-1)).toMatchObject({
      kind: "attempt_updated",
      runId: "run-1",
    });
  });

  it("clears copied lifecycle provenance on manual status patches", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Clear copied provenance" });
    const lifecycleMoved = await store.update(card.id, {
      status: "review",
      metadata: {
        lifecycleStatusSourceUpdatedAt: 1000,
        stale: {
          kind: "session",
          status: "done",
          updatedAt: 1000,
          observedAt: 1000,
        },
      },
    });

    const manual = await store.update(card.id, {
      status: "running",
      metadata: {
        ...lifecycleMoved.metadata,
        stale: null,
      },
    });

    expect(manual.status).toBe("running");
    expect(manual.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();

    const staleLifecycle = await store.update(card.id, {
      status: "review",
      metadata: { lifecycleStatusSourceUpdatedAt: 1000 },
    });
    expect(staleLifecycle.status).toBe("running");
    expect(staleLifecycle.metadata?.lifecycleStatusSourceUpdatedAt).toBeUndefined();
  });

  it("keeps execution session links aligned with edited card links", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Relink me",
      sessionKey: "agent:main:dashboard:1",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const relinked = await store.update(card.id, { sessionKey: "agent:main:dashboard:2" });
    expect(relinked.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.execution?.sessionKey).toBe("agent:main:dashboard:2");
    expect(relinked.events?.at(-1)).toMatchObject({
      kind: "linked",
      sessionKey: "agent:main:dashboard:2",
    });

    const unlinked = await store.update(card.id, { sessionKey: "" });
    expect(unlinked.sessionKey).toBeUndefined();
    expect(unlinked.execution?.sessionKey).toBeUndefined();

    const cleared = await store.update(card.id, { execution: null });
    expect(cleared.execution).toBeUndefined();
  });

  it("tracks execution attempts as card metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Run worker" });

    const running = await store.update(card.id, {
      status: "running",
      execution: {
        id: "exec-1",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        sessionKey: "agent:main:dashboard:1",
        runId: "run-1",
        startedAt: 10,
        updatedAt: 10,
      },
    });
    expect(running.metadata?.attempts).toEqual([
      expect.objectContaining({
        id: "run-1",
        status: "running",
        engine: "codex",
        runId: "run-1",
      }),
    ]);
    expect(running.events?.at(-1)).toMatchObject({ kind: "moved" });

    const blocked = await store.update(card.id, {
      execution: {
        ...running.execution!,
        status: "blocked",
        updatedAt: 20,
      },
    });

    expect(blocked.metadata?.attempts?.[0]).toMatchObject({
      status: "blocked",
      endedAt: 20,
    });
    expect(blocked.metadata?.failureCount).toBe(1);
    expect(blocked.events?.at(-1)).toMatchObject({ kind: "attempt_updated", runId: "run-1" });

    const commented = await store.addComment(card.id, { body: "Need provider follow-up." });
    expect(commented.metadata?.failureCount).toBe(1);
    expect(commented.metadata?.attempts?.[0]).toMatchObject({
      status: "blocked",
      endedAt: 20,
    });

    const retrying = await store.update(card.id, {
      execution: {
        ...running.execution!,
        id: "exec-2",
        runId: "run-2",
        status: "running",
        startedAt: 30,
        updatedAt: 30,
      },
    });
    expect(retrying.metadata?.failureCount).toBe(1);
    expect(retrying.metadata?.attempts?.[1]).toMatchObject({
      id: "run-2",
      startedAt: 30,
      status: "running",
    });

    const blockedAgain = await store.update(card.id, {
      execution: {
        ...retrying.execution!,
        status: "blocked",
        updatedAt: 40,
      },
    });
    expect(blockedAgain.metadata?.failureCount).toBe(2);
  });

  it("adds comments, links, proof, and archive metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Track proof" });

    const commented = await store.addComment(card.id, { body: "Reviewer asked for screenshots." });
    expect(commented.metadata?.comments?.[0]).toMatchObject({
      body: "Reviewer asked for screenshots.",
    });
    expect(commented.events?.at(-1)).toMatchObject({ kind: "comment_added" });

    const linked = await store.addLink(card.id, {
      type: "blocked_by",
      targetCardId: "card-upstream",
      title: "Upstream fix",
    });
    expect(linked.metadata?.links?.[0]).toMatchObject({
      type: "blocked_by",
      targetCardId: "card-upstream",
    });
    expect(linked.events?.at(-1)).toMatchObject({ kind: "link_added" });
    await expect(
      store.addLink(card.id, { type: "parent", targetCardId: "card-upstream" }),
    ).rejects.toThrow(/linkDependency/);

    const proven = await store.addProof(card.id, {
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(proven.metadata?.proof?.[0]).toMatchObject({
      status: "passed",
      command: "pnpm test extensions/workboard",
    });
    expect(proven.events?.at(-1)).toMatchObject({ kind: "proof_added" });

    const artifacted = await store.addArtifact(card.id, {
      label: "Screenshot",
      path: "/tmp/workboard.png",
      mimeType: "image/png",
    });
    expect(artifacted.metadata?.artifacts?.[0]).toMatchObject({
      label: "Screenshot",
      path: "/tmp/workboard.png",
    });
    expect(artifacted.events?.at(-1)).toMatchObject({ kind: "artifact_added" });

    const archived = await store.archive(card.id, true);
    expect(archived.metadata?.archivedAt).toBeGreaterThan(0);
    expect(archived.events?.at(-1)).toMatchObject({ kind: "archived" });

    const restored = await store.archive(card.id, false);
    expect(restored.metadata?.archivedAt).toBeUndefined();
    expect(restored.events?.at(-1)).toMatchObject({ kind: "unarchived" });
  });

  it("stores attachments in the plugin kv namespace and adds worker context", async () => {
    const attachments = createMemoryStore<PersistedWorkboardAttachment>();
    const store = new WorkboardStore(createMemoryStore(), { attachments });
    const card = await store.create({ title: "Review attached log" });

    const attached = await store.addAttachment(card.id, {
      fileName: "failure.log",
      mimeType: "text/plain",
      note: "Captured failing run",
      contentBase64: Buffer.from("stack trace").toString("base64"),
    });

    expect(attached.metadata?.attachments?.[0]).toMatchObject({
      fileName: "failure.log",
      byteSize: "stack trace".length,
      mimeType: "text/plain",
    });
    expect(attached.events?.at(-1)).toMatchObject({ kind: "attachment_added" });
    const attachment = attached.metadata?.attachments?.[0];
    if (!attachment) {
      throw new Error("expected attachment metadata");
    }
    const persisted = await store.getAttachment(attachment.id);
    if (!persisted) {
      throw new Error("expected persisted attachment");
    }
    expect(Buffer.from(persisted.contentBase64, "base64").toString("utf8")).toBe("stack trace");
    await expect(
      store.addAttachment(card.id, {
        fileName: "huge.bin",
        contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64"),
      }),
    ).rejects.toThrow(/attachment must be/);
    await expect(
      store.addAttachment(card.id, {
        fileName: "sqlite-sized.bin",
        contentBase64: Buffer.alloc(70 * 1024).toString("base64"),
      }),
    ).resolves.toMatchObject({
      metadata: {
        attachments: expect.arrayContaining([
          expect.objectContaining({ fileName: "sqlite-sized.bin" }),
        ]),
      },
    });
    await expect(
      store.addAttachment(card.id, {
        fileName: "padded.txt",
        contentBase64: `${Buffer.from("ok").toString("base64")}\n`,
      }),
    ).rejects.toThrow(/canonical base64/);

    const context = await store.buildWorkerContext(card.id);
    expect(context).toContain("failure.log");

    const deleted = await store.deleteAttachment(card.id, attachment.id);
    expect(deleted.metadata?.attachments).toEqual([
      expect.objectContaining({ fileName: "sqlite-sized.bin" }),
    ]);
    expect(deleted.events?.at(-1)).toMatchObject({ kind: "edited" });
    expect(await store.getAttachment(attachment.id)).toBeUndefined();
  });

  it("removes attachment blobs when the card attachment index prunes old entries", async () => {
    const attachments = createMemoryStore<PersistedWorkboardAttachment>();
    const store = new WorkboardStore(createMemoryStore(), { attachments });
    const card = await store.create({ title: "Many attachments" });
    let firstAttachmentId = "";

    for (let index = 0; index < 21; index += 1) {
      const updated = await store.addAttachment(card.id, {
        fileName: `log-${index}.txt`,
        contentBase64: Buffer.from(`log ${index}`).toString("base64"),
      });
      firstAttachmentId ||= updated.metadata?.attachments?.[0]?.id ?? "";
    }

    const saved = await store.get(card.id);
    expect(saved?.metadata?.attachments).toHaveLength(20);
    expect(await store.getAttachment(firstAttachmentId)).toBeUndefined();
    const exported = await store.exportCards();
    expect(exported.attachments).toHaveLength(20);
    expect(exported.attachments[0]).not.toHaveProperty("contentBase64");
  });

  it("records worker logs and protocol violations on cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Protocol card",
      status: "running",
      sessionKey: "session-protocol",
      runId: "run-protocol",
      execution: {
        id: "exec-protocol",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 10,
        updatedAt: 10,
      },
    });

    const logged = await store.addWorkerLog(card.id, {
      level: "warning",
      message: "Worker nearing timeout.",
    });
    expect(logged.metadata?.workerLogs?.[0]).toMatchObject({
      level: "warning",
      message: "Worker nearing timeout.",
    });
    expect(logged.events?.at(-1)).toMatchObject({ kind: "orchestration" });

    const violated = await store.recordProtocolViolation(card.id, {
      detail: "Worker exited without workboard_complete.",
      sessionKey: "observed-session",
      runId: "observed-run",
    });
    expect(violated.status).toBe("blocked");
    expect(violated.execution?.status).toBe("blocked");
    expect(violated.metadata?.attempts).toEqual([
      expect.objectContaining({
        status: "blocked",
        error: "Worker exited without workboard_complete.",
      }),
    ]);
    expect(violated.metadata?.workerProtocol).toMatchObject({
      state: "violated",
      detail: "Worker exited without workboard_complete.",
    });
    expect(violated.metadata?.failureCount).toBe(1);
    expect(violated.metadata?.notifications).toEqual([
      expect.objectContaining({
        kind: "failed",
        sessionKey: "observed-session",
        runId: "observed-run",
      }),
    ]);
    expect(violated.events?.at(-1)).toMatchObject({ kind: "protocol_violation" });
  });

  it("keeps concurrent metadata appends from dropping siblings", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Collect notes" });

    await Promise.all([
      store.addComment(card.id, { body: "First note." }),
      store.addComment(card.id, { body: "Second note." }),
    ]);

    const saved = await store.get(card.id);
    expect(saved?.metadata?.comments?.map((comment) => comment.body).toSorted()).toEqual([
      "First note.",
      "Second note.",
    ]);
  });

  it("keeps metadata under the keyed-store value budget", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Collect a lot of notes" });

    for (let index = 0; index < 50; index += 1) {
      await store.addComment(card.id, {
        body: `${String(index).padStart(2, "0")} ${"x".repeat(1990)}`,
      });
    }

    const saved = await store.get(card.id);
    expect(Buffer.byteLength(JSON.stringify(saved?.metadata), "utf8")).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(saved?.metadata?.comments?.at(-1)?.body).toContain("49 ");
    expect(saved?.metadata?.comments?.length).toBeLessThan(50);
  });

  it("records append events when metadata retention drops old comments", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Track retained comments" });

    let updated = card;
    for (let index = 0; index < 51; index += 1) {
      updated = await store.addComment(card.id, { body: `Note ${index}` });
    }

    expect(updated.metadata?.comments).toHaveLength(50);
    expect(updated.metadata?.comments?.at(0)?.body).toBe("Note 1");
    expect(updated.events?.at(-1)).toMatchObject({ kind: "comment_added" });
  });

  it("keeps queued metadata when lifecycle updates add stale state", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Sync stale state" });

    await Promise.all([
      store.update(card.id, {
        status: "running",
        metadata: {
          stale: {
            detectedAt: 10,
            lastSessionUpdatedAt: 1,
            reason: "Linked session has not reported recent activity.",
          },
        },
      }),
      store.addComment(card.id, { body: "Operator note." }),
    ]);

    const saved = await store.get(card.id);
    expect(saved?.status).toBe("running");
    expect(saved?.metadata?.stale?.lastSessionUpdatedAt).toBe(1);
    expect(saved?.metadata?.comments?.map((comment) => comment.body)).toContain("Operator note.");
  });

  it("exports card records with metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Export me", templateId: "docs" });

    await expect(store.exportCards()).resolves.toMatchObject({
      cards: [expect.objectContaining({ id: card.id, metadata: { templateId: "docs" } })],
      exportedAt: expect.any(Number),
    });
  });

  it("claims cards, heartbeats, and releases the claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Coordinate worker", status: "todo" });

    const claimed = await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

    expect(claimed.token).toBeTruthy();
    expect(claimed.card.status).toBe("running");
    expect(claimed.card.agentId).toBe("main");
    expect(claimed.card.metadata?.claim).toMatchObject({ ownerId: "main" });

    await expect(store.claim(card.id, { ownerId: "other" })).rejects.toThrow(/already claimed/);

    const heartbeat = await store.heartbeat(card.id, {
      ownerId: "main",
      note: "Still running tests.",
    });
    expect(heartbeat.events?.at(-1)).toMatchObject({ kind: "heartbeat" });
    expect(heartbeat.metadata?.comments?.at(-1)?.body).toBe("Still running tests.");

    await expect(store.heartbeat(card.id, { ownerId: "other" })).rejects.toThrow(/owner/);

    const released = await store.releaseClaim(card.id, { ownerId: "main", status: "review" });
    expect(released.status).toBe("review");
    expect(released.metadata?.claim).toBeUndefined();
  });

  it("caps oversized claim TTL seconds to a valid Date timestamp", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Bound claim", status: "todo" });

      const claimed = await store.claim(card.id, {
        ownerId: "main",
        ttlSeconds: Number.MAX_SAFE_INTEGER,
      });

      expect(claimed.card.metadata?.claim?.expiresAt).toBe(MAX_DATE_TIMESTAMP_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let invalid stored claim expiry block a fresh claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Invalid claim expiry",
      status: "todo",
      metadata: {
        claim: {
          ownerId: "stale-worker",
          token: "stale-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Number.MAX_VALUE,
        },
      },
    });

    const claimed = await store.claim(card.id, { ownerId: "main", token: "fresh-token" });

    expect(claimed.card.metadata?.claim).toMatchObject({
      ownerId: "main",
      token: "fresh-token",
    });
  });

  it("creates idempotent child cards and promotes them when parents finish", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({
      title: "Child",
      status: "todo",
      parents: [parent.id],
      tenant: "release",
      idempotencyKey: "fanout:1",
      skills: ["testing"],
      workspace: { kind: "scratch" },
    });

    expect(child.status).toBe("todo");
    expect(child.metadata?.links).toEqual([
      expect.objectContaining({ type: "parent", targetCardId: parent.id }),
    ]);
    await expect(store.get(parent.id)).resolves.toMatchObject({
      metadata: { links: [expect.objectContaining({ type: "child", targetCardId: child.id })] },
    });
    await expect(
      store.create({
        title: "Duplicate child",
        tenant: "release",
        idempotencyKey: "fanout:1",
      }),
    ).resolves.toMatchObject({ id: child.id });
    await expect(
      store.create({
        title: "Different tenant child",
        tenant: "qa",
        idempotencyKey: "fanout:1",
      }),
    ).resolves.toMatchObject({ title: "Different tenant child" });
    await expect(
      store.create({ title: "Unscoped child", idempotencyKey: "fanout:1" }),
    ).resolves.toMatchObject({ title: "Unscoped child" });

    await store.complete(parent.id, { summary: "Parent done." });
    const promoted = await store.promoteReady();

    expect(promoted.cards).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          tenant: "release",
          idempotencyKey: "fanout:1",
          skills: ["testing"],
          workspace: { kind: "scratch" },
        },
      },
    });
  });

  it("returns an idempotent child retry when its original parent was deleted", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Ephemeral parent" });
    const child = await store.create({
      title: "Retryable child",
      parents: [parent.id],
      tenant: "release",
      idempotencyKey: "fanout:deleted-parent",
    });

    await store.delete(parent.id);

    await expect(
      store.create({
        title: "Retryable child",
        parents: [parent.id],
        tenant: "release",
        idempotencyKey: "fanout:deleted-parent",
      }),
    ).resolves.toMatchObject({ id: child.id });
  });

  it("accepts POSIX and Windows absolute directory workspaces", async () => {
    const store = new WorkboardStore(createMemoryStore());

    await expect(
      store.create({
        title: "POSIX workspace",
        workspace: { kind: "dir", path: "/Users/me/repo" },
      }),
    ).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/Users/me/repo" } } },
    });
    await expect(
      store.create({
        title: "Windows drive workspace",
        workspace: { kind: "dir", path: String.raw`C:\Users\me\repo` },
      }),
    ).resolves.toMatchObject({
      metadata: {
        automation: { workspace: { kind: "dir", path: String.raw`C:\Users\me\repo` } },
      },
    });
    await expect(
      store.create({
        title: "Windows UNC workspace",
        workspace: { kind: "dir", path: String.raw`\\server\share\repo` },
      }),
    ).resolves.toMatchObject({
      metadata: {
        automation: { workspace: { kind: "dir", path: String.raw`\\server\share\repo` } },
      },
    });
    await expect(
      store.create({ title: "Relative workspace", workspace: { kind: "dir", path: "repo" } }),
    ).rejects.toThrow(/absolute/);
  });

  it("keeps future scheduled cards scheduled until their time arrives", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Later",
        status: "scheduled",
        scheduledAt: 10_000,
      });
      const manual = await store.create({
        title: "Manual scheduled",
        status: "scheduled",
      });
      const implicit = await store.create({
        title: "Implicit later",
        scheduledAt: 10_000,
      });
      const activeRequested = await store.create({
        title: "Active requested later",
        status: "running",
        scheduledAt: 10_000,
        execution: {
          id: "exec-scheduled",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "openai/gpt-5.5",
          startedAt: 0,
          updatedAt: 0,
        },
      });
      const parent = await store.create({ title: "Parent", status: "running" });
      const dependent = await store.create({
        title: "Dependent later",
        status: "scheduled",
        parents: [parent.id],
        scheduledAt: 10_000,
      });

      expect((await store.dispatch(1_000)).promoted).toEqual([]);
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.get(manual.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.get(implicit.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.get(activeRequested.id)).resolves.toMatchObject({ status: "scheduled" });
      expect((await store.get(activeRequested.id))?.execution).toBeUndefined();
      expect((await store.get(activeRequested.id))?.metadata?.attempts).toBeUndefined();
      await expect(store.get(dependent.id)).resolves.toMatchObject({ status: "scheduled" });
      await expect(store.claim(card.id, { ownerId: "main" })).rejects.toThrow(/scheduled/);
      await expect(store.claim(manual.id, { ownerId: "main" })).rejects.toThrow(/scheduled/);
      await expect(store.claim(implicit.id, { ownerId: "main" })).rejects.toThrow(/scheduled/);
      await expect(store.move(manual.id, "running", manual.position)).rejects.toThrow(/scheduled/);

      await store.complete(parent.id, { summary: "Parent done." });
      expect((await store.dispatch(5_000)).promoted).toEqual([]);
      await expect(store.get(dependent.id)).resolves.toMatchObject({ status: "scheduled" });

      expect((await store.dispatch(20_000)).promoted).toEqual([
        expect.objectContaining({ id: card.id, status: "ready" }),
        expect.objectContaining({ id: implicit.id, status: "ready" }),
        expect.objectContaining({ id: activeRequested.id, status: "ready" }),
        expect.objectContaining({ id: dependent.id, status: "ready" }),
      ]);
      await expect(store.get(manual.id)).resolves.toMatchObject({ status: "scheduled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds dependent cards out of runnable statuses until parents finish", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({
      title: "Child",
      status: "running",
      parents: [parent.id],
      execution: {
        id: "exec-held",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 1,
        updatedAt: 1,
      },
    });

    expect(child.status).toBe("todo");
    expect(child.execution).toBeUndefined();
    expect(child.metadata?.attempts).toBeUndefined();
    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(/dependencies/);
    await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(/dependencies/);
    await expect(store.move(child.id, "running", child.position)).rejects.toThrow(/dependencies/);
    await expect(store.move(child.id, "done", child.position)).rejects.toThrow(/dependencies/);
    await expect(store.update(child.id, { status: "ready" })).rejects.toThrow(/dependencies/);
    await expect(store.update(child.id, { status: "done" })).rejects.toThrow(/dependencies/);
    await expect(store.complete(child.id, { summary: "Too early." })).rejects.toThrow(
      /dependencies/,
    );

    const linked = await store.update(child.id, {
      metadata: {
        links: [
          {
            id: "ordinary-link",
            type: "relates_to",
            createdAt: Date.now(),
            url: "https://example.com/work",
          },
        ],
      },
    });
    expect(linked.metadata?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "parent", targetCardId: parent.id }),
        expect.objectContaining({ type: "relates_to", url: "https://example.com/work" }),
      ]),
    );
    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(/dependencies/);

    await store.complete(parent.id, { summary: "Parent done." });
    const dispatch = await store.dispatch();

    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
    const claimed = await store.claim(child.id, { ownerId: "main" });
    expect(claimed.card.status).toBe("running");

    await store.update(parent.id, { status: "running" });
    await store.dispatch();
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: expect.objectContaining({ ownerId: "main" }) },
    });
    await expect(store.releaseClaim(child.id, { ownerId: "main", status: "done" })).rejects.toThrow(
      /dependencies/,
    );
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "running",
      metadata: { claim: expect.objectContaining({ ownerId: "main" }) },
    });

    const lateParent = await store.create({ title: "Late parent" });
    await expect(store.linkCards(lateParent.id, child.id)).rejects.toThrow(/active child/);
  });

  it("rejects terminal children with incomplete dependency parents", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const runningParent = await store.create({ title: "Running parent", status: "running" });
    const doneChild = await store.create({ title: "Done child", status: "done" });

    await expect(store.linkCards(runningParent.id, doneChild.id)).rejects.toThrow(/terminal child/);
    await expect(
      store.create({ title: "Already done", status: "done", parents: [runningParent.id] }),
    ).rejects.toThrow(/terminal child/);

    const doneParent = await store.create({ title: "Done parent", status: "done" });
    await expect(store.linkCards(doneParent.id, doneChild.id)).resolves.toMatchObject({
      id: doneChild.id,
      status: "done",
    });
  });

  it("preserves dependency links across link caps and parent deletion", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({ title: "Child", parents: [parent.id] });

    for (let index = 0; index < 60; index += 1) {
      await store.addLink(child.id, {
        type: "relates_to",
        url: `https://example.com/${index}`,
      });
    }

    await expect(store.claim(child.id, { ownerId: "main" })).rejects.toThrow(/dependencies/);

    await store.delete(parent.id);
    const claimed = await store.claim(child.id, { ownerId: "main" });

    expect(claimed.card.status).toBe("running");
    expect(claimed.card.metadata?.links?.some((link) => link.targetCardId === parent.id)).toBe(
      false,
    );
  });

  it("rolls back card creation when dependency link capacity rejects the parent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Fanout parent" });
    for (let index = 0; index < 50; index += 1) {
      await store.create({ title: `Child ${index}`, parents: [parent.id] });
    }

    await expect(
      store.create({
        title: "Overflow child",
        parents: [parent.id],
        idempotencyKey: "overflow",
      }),
    ).rejects.toThrow(/link limit/);

    expect((await store.list()).some((card) => card.title === "Overflow child")).toBe(false);
  });

  it("rejects invalid parent creates without persisting partial cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parents: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      parents.push((await store.create({ title: `Parent ${index}` })).id);
    }

    await expect(
      store.create({
        title: "Too many parents",
        parents,
      }),
    ).rejects.toThrow(/parents supports at most 20 entries/);
    await expect(
      store.create({
        title: "Malformed parents",
        parents: [parents[0], 123],
      }),
    ).rejects.toThrow(/parents entries must be strings/);

    await expect(
      store.create({
        title: "Orphan child",
        parents: ["missing-parent"],
        idempotencyKey: "fanout:missing",
      }),
    ).rejects.toThrow(/card not found: missing-parent/);

    expect((await store.list()).some((card) => card.title === "Too many parents")).toBe(false);
    expect((await store.list()).some((card) => card.title === "Malformed parents")).toBe(false);
    expect((await store.list()).some((card) => card.title === "Orphan child")).toBe(false);
  });

  it("rejects dependency cycles", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({ title: "First" });
    const second = await store.create({ title: "Second", parents: [first.id] });

    await expect(store.linkCards(second.id, first.id)).rejects.toThrow(/cycle/);
  });

  it("completes and blocks claimed cards with structured handoff metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ship child",
      status: "running",
      execution: {
        id: "exec-complete",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });
    const child = await store.create({ title: "Follow-up", parents: [card.id] });
    const claimed = await store.claim(card.id, { ownerId: "main", token: "token-1" });

    const completed = await store.complete(claimed.card.id, {
      ownerId: "main",
      token: "token-1",
      summary: "Implemented and verified.",
      proof: { status: "passed", command: "pnpm test extensions/workboard" },
      artifacts: [{ path: "/tmp/log.txt", label: "log" }],
      createdCardIds: [child.id],
    });

    expect(completed).toMatchObject({
      status: "done",
      execution: { status: "done" },
      metadata: {
        attempts: [expect.objectContaining({ status: "succeeded", endedAt: expect.any(Number) })],
        comments: [expect.objectContaining({ body: "Implemented and verified." })],
        proof: [expect.objectContaining({ status: "passed" })],
        artifacts: [expect.objectContaining({ path: "/tmp/log.txt" })],
        automation: { summary: "Implemented and verified.", createdCardIds: [child.id] },
        notifications: [expect.objectContaining({ kind: "completed" })],
      },
    });
    expect(completed.metadata?.claim).toBeUndefined();

    const blockedCard = await store.create({
      title: "Blocked work",
      status: "running",
      execution: {
        id: "exec-block",
        kind: "agent-session",
        engine: "claude",
        mode: "autonomous",
        status: "running",
        model: "anthropic/claude-sonnet-4.6",
        startedAt: 1_000,
        updatedAt: 1_000,
      },
    });
    await store.claim(blockedCard.id, { ownerId: "main", token: "token-2" });
    const blocked = await store.block(blockedCard.id, {
      ownerId: "main",
      token: "token-2",
      reason: "Needs owner decision.",
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.execution?.status).toBe("blocked");
    expect(blocked.metadata?.attempts).toEqual([
      expect.objectContaining({
        status: "blocked",
        endedAt: expect.any(Number),
        error: "Needs owner decision.",
      }),
    ]);
    expect(blocked.metadata?.failureCount).toBe(1);
    expect(blocked.metadata?.claim).toBeUndefined();
    expect(blocked.metadata?.notifications).toEqual([
      expect.objectContaining({ kind: "failed", message: "Needs owner decision." }),
    ]);

    const recovered = await store.complete(
      (
        await store.create({
          title: "Recovered work",
          status: "running",
          metadata: { failureCount: 2 },
        })
      ).id,
      { summary: "Recovered." },
    );
    expect(recovered.metadata?.failureCount).toBeUndefined();
  });

  it("keeps long lifecycle handoffs in comments while capping notifications", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const completeCard = await store.create({ title: "Long complete" });
    const blockCard = await store.create({ title: "Long block" });
    const longSummary = "x".repeat(1000);
    const longReason = "y".repeat(1000);

    const completed = await store.complete(completeCard.id, { summary: longSummary });
    const blocked = await store.block(blockCard.id, { reason: longReason });

    expect(completed.metadata?.comments?.[0]?.body).toBe(longSummary);
    expect(completed.metadata?.notifications?.[0]?.message.length).toBeLessThanOrEqual(240);
    expect(blocked.metadata?.comments?.[0]?.body).toBe(longReason);
    expect(blocked.metadata?.notifications?.[0]?.message.length).toBeLessThanOrEqual(240);
  });

  it("dispatches ready cards and blocks expired or timed-out work", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const ready = await store.create({ title: "Ready", status: "ready" });
      const readyUpdatedAt = ready.updatedAt;
      const expired = await store.create({ title: "Expired", status: "running" });
      await store.claim(expired.id, { ownerId: "main", token: "token-1", ttlSeconds: 1 });
      const timed = await store.create({
        title: "Timed",
        status: "running",
        maxRuntimeSeconds: 1,
        execution: {
          id: "exec-1",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "openai/gpt-5.5",
          startedAt: 1_000,
          updatedAt: 1_000,
        },
      });
      const claimedTimed = await store.create({
        title: "Claimed timed",
        status: "ready",
        maxRuntimeSeconds: 1,
      });
      await store.claim(claimedTimed.id, { ownerId: "main", token: "token-2", ttlSeconds: 60 });
      const createdRunningTimed = await store.create({
        title: "Created running timed",
        status: "running",
        maxRuntimeSeconds: 1,
      });

      const result = await store.dispatch(10 * 60 * 1000);

      expect(createdRunningTimed.startedAt).toBe(1_000);
      expect(result.count).toBe(4);
      await expect(store.get(ready.id)).resolves.toMatchObject({
        updatedAt: readyUpdatedAt,
        metadata: { automation: { dispatchCount: 1, lastDispatchAt: 600_000 } },
        events: expect.arrayContaining([expect.objectContaining({ kind: "dispatch" })]),
      });
      const blockedExpired = await store.get(expired.id);
      expect(blockedExpired).toMatchObject({ status: "blocked" });
      expect(blockedExpired?.metadata?.claim).toBeUndefined();
      await expect(store.get(timed.id)).resolves.toMatchObject({
        status: "blocked",
        execution: { status: "blocked" },
        metadata: {
          attempts: [expect.objectContaining({ status: "blocked", endedAt: 600_000 })],
        },
      });
      const blockedClaimed = await store.get(claimedTimed.id);
      expect(blockedClaimed).toMatchObject({ status: "blocked" });
      expect(blockedClaimed?.metadata?.claim).toBeUndefined();
      expect(blockedClaimed?.metadata?.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "Run exceeded the card max runtime." }),
        ]),
      );
      await expect(store.get(createdRunningTimed.id)).resolves.toMatchObject({
        status: "blocked",
        metadata: {
          notifications: expect.arrayContaining([
            expect.objectContaining({ message: "Run exceeded the card max runtime." }),
          ]),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized max runtime seconds during dispatch timeout checks", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({
        title: "Bound runtime",
        status: "running",
        maxRuntimeSeconds: Number.MAX_SAFE_INTEGER,
      });
      if (card.startedAt === undefined) {
        throw new Error("expected running card to have startedAt");
      }

      const result = await store.dispatch(card.startedAt + Number.MAX_SAFE_INTEGER + 1);

      expect(result.blocked).toEqual([expect.objectContaining({ id: card.id })]);
      await expect(store.get(card.id)).resolves.toMatchObject({ status: "blocked" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets in-flight retries finish before enforcing the retry budget", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const retrying = await store.create({
      title: "Retrying",
      status: "ready",
      maxRetries: 1,
      metadata: { failureCount: 1 },
    });
    await store.claim(retrying.id, { ownerId: "main", token: "token-1" });

    const retryDispatch = await store.dispatch();

    expect(retryDispatch.blocked).toEqual([]);
    await expect(store.get(retrying.id)).resolves.toMatchObject({ status: "running" });

    const exhausted = await store.create({
      title: "Exhausted",
      status: "ready",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    const exhaustedTodo = await store.create({
      title: "Exhausted todo",
      status: "todo",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    const exhaustedBacklog = await store.create({
      title: "Exhausted backlog",
      status: "backlog",
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    await expect(store.claim(exhausted.id, { ownerId: "main" })).rejects.toThrow(/retry budget/);

    const exhaustedDispatch = await store.dispatch();

    expect(exhaustedDispatch.blocked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: exhausted.id, status: "blocked" }),
        expect.objectContaining({ id: exhaustedTodo.id, status: "blocked" }),
        expect.objectContaining({ id: exhaustedBacklog.id, status: "blocked" }),
      ]),
    );
    await expect(store.get(exhausted.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: {
        notifications: [expect.objectContaining({ message: "Card exhausted its retry budget." })],
      },
    });

    const parent = await store.create({ title: "Parent retry gate", status: "running" });
    const dependent = await store.create({
      title: "Dependent exhausted",
      parents: [parent.id],
      maxRetries: 1,
      metadata: { failureCount: 2 },
    });
    await store.complete(parent.id, { summary: "Parent done." });

    const dependentDispatch = await store.dispatch();

    expect(dependentDispatch.promoted.some((card) => card.id === dependent.id)).toBe(false);
    expect(dependentDispatch.blocked).toEqual([
      expect.objectContaining({ id: dependent.id, status: "blocked" }),
    ]);
  });

  it("extends claim expiry by the original TTL on heartbeat", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Long run" });
      await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

      vi.setSystemTime(31_000);
      const heartbeat = await store.heartbeat(card.id, { ownerId: "main" });

      expect(heartbeat.metadata?.claim).toMatchObject({
        claimedAt: 1_000,
        lastHeartbeatAt: 31_000,
        expiresAt: 91_000,
      });

      vi.setSystemTime(61_000);
      const secondHeartbeat = await store.heartbeat(card.id, { ownerId: "main" });
      expect(secondHeartbeat.metadata?.claim).toMatchObject({
        claimedAt: 1_000,
        lastHeartbeatAt: 61_000,
        expiresAt: 121_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps heartbeat claim renewal to a valid Date timestamp", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(MAX_DATE_TIMESTAMP_MS - 30_000);
      const store = new WorkboardStore(createMemoryStore());
      const card = await store.create({ title: "Near date limit" });
      await store.claim(card.id, { ownerId: "main", ttlSeconds: 60 });

      vi.setSystemTime(MAX_DATE_TIMESTAMP_MS - 10_000);
      const heartbeat = await store.heartbeat(card.id, { ownerId: "main" });

      expect(heartbeat.metadata?.claim?.expiresAt).toBe(MAX_DATE_TIMESTAMP_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the claim when release status validation fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Keep claim" });
    await store.claim(card.id, { ownerId: "main", token: "token-1" });

    await expect(
      store.releaseClaim(card.id, { ownerId: "main", token: "token-1", status: "invalid" }),
    ).rejects.toThrow(/status must be one of/);

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: { claim: { ownerId: "main", token: "token-1" } },
    });
  });

  it("checks mutation claim scope inside queued card writes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Scoped mutation" });
    await store.claim(card.id, { ownerId: "main", token: "token-1" });

    await expect(
      store.addComment(card.id, { body: "stale write" }, { ownerId: "other" }),
    ).rejects.toThrow(/claimed by main/);
    await expect(store.get(card.id)).resolves.not.toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "stale write" })] },
    });

    await expect(
      store.addComment(card.id, { body: "owner write" }, { ownerId: "main" }),
    ).resolves.toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "owner write" })] },
    });
  });

  it("clears resolved proof diagnostics when adding proof", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Needs proof",
      status: "done",
      metadata: {
        diagnostics: [
          {
            kind: "missing_proof",
            severity: "warning",
            title: "Missing proof",
            detail: "Done card needs proof.",
            actions: [],
            detectedAt: 10,
          },
        ],
      },
    });

    const updated = await store.addProof(card.id, { status: "passed", label: "CI" });

    expect(updated.metadata?.proof).toEqual([expect.objectContaining({ label: "CI" })]);
    expect(updated.metadata?.diagnostics).toBeUndefined();
  });

  it("clears resolved proof diagnostics when adding an artifact", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Needs artifact",
      status: "done",
      metadata: {
        diagnostics: [
          {
            kind: "missing_proof",
            severity: "warning",
            title: "Missing proof",
            detail: "Done card needs proof.",
            actions: [],
            detectedAt: 10,
          },
        ],
      },
    });

    const updated = await store.addArtifact(card.id, { label: "log", path: "/tmp/log.txt" });

    expect(updated.metadata?.artifacts).toEqual([expect.objectContaining({ label: "log" })]);
    expect(updated.metadata?.diagnostics).toBeUndefined();
  });

  it("does not commit proof when proof artifact validation fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Atomic proof" });

    await expect(
      store.addProofWithArtifact(
        card.id,
        { status: "passed", label: "CI" },
        { path: "x".repeat(2001) },
      ),
    ).rejects.toThrow(/artifact path/);

    await expect(store.get(card.id)).resolves.not.toMatchObject({
      metadata: { proof: [expect.objectContaining({ label: "CI" })] },
    });
  });

  it("computes and refreshes card diagnostics", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ready = await store.create({
      title: "Ready too long",
      agentId: "main",
      position: 10,
    });
    const running = await store.create({ title: "Loose run", status: "running", sessionKey: "s1" });
    const failed = await store.create({
      title: "Failed twice",
      status: "blocked",
      metadata: { failureCount: 2 },
    });
    const doneWithAttachment = await store.create({
      title: "Done with attachment",
      status: "done",
      metadata: {
        attachments: [
          {
            id: "attachment-proof",
            cardId: "attachment-card",
            fileName: "result.log",
            byteSize: 1,
            createdAt: 10,
          },
        ],
      },
    });

    const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const diagnostics = await store.refreshDiagnostics(now);

    expect(diagnostics.count).toBeGreaterThanOrEqual(4);
    await expect(store.get(ready.id)).resolves.toMatchObject({ updatedAt: ready.updatedAt });
    await expect(store.get(ready.id)).resolves.toMatchObject({
      metadata: { diagnostics: [expect.objectContaining({ kind: "stranded_ready" })] },
    });
    await expect(store.get(running.id)).resolves.toMatchObject({
      metadata: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ kind: "running_without_heartbeat" }),
          expect.objectContaining({ kind: "orphaned_session" }),
        ]),
      },
    });
    await expect(store.get(failed.id)).resolves.toMatchObject({
      metadata: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ kind: "blocked_too_long" }),
          expect.objectContaining({ kind: "repeated_failures" }),
        ]),
      },
    });
    await expect(store.get(doneWithAttachment.id)).resolves.not.toMatchObject({
      metadata: {
        diagnostics: expect.arrayContaining([expect.objectContaining({ kind: "missing_proof" })]),
      },
    });
  });

  it("does not drop concurrent updates while refreshing diagnostics", async () => {
    let proofPromise: Promise<unknown> | undefined;
    let triggered = false;
    const keyed = createMemoryStore({
      async beforeRegister(_key, value) {
        if (triggered || !value.card.metadata?.diagnostics?.length) {
          return;
        }
        triggered = true;
        proofPromise = store.addProof(value.card.id, { status: "passed", label: "CI" });
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      },
    });
    const store: WorkboardStore = new WorkboardStore(keyed);
    const card = await store.create({ title: "Ready too long", agentId: "main" });

    await store.refreshDiagnostics(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await proofPromise;

    await expect(store.get(card.id)).resolves.toMatchObject({
      metadata: {
        diagnostics: [expect.objectContaining({ kind: "stranded_ready" })],
        proof: [expect.objectContaining({ label: "CI" })],
      },
    });
  });

  it("builds bounded worker context from card metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Write docs",
      notes: "Acceptance:\n- mention tools",
      agentId: "main",
      metadata: {
        comments: [{ id: "comment-1", body: "Need proof.", createdAt: 10 }],
        proof: [{ id: "proof-1", status: "passed", command: "pnpm test", createdAt: 12 }],
        artifacts: [
          { id: "artifact-1", label: "Failure screenshot", path: "/tmp/fail.png", createdAt: 13 },
        ],
      },
    });

    await expect(store.buildWorkerContext(card.id)).resolves.toContain("## Recent comments");
    await expect(store.buildWorkerContext(card.id)).resolves.toContain("pnpm test");
    await expect(store.buildWorkerContext(card.id)).resolves.toContain("Failure screenshot");
  });

  it("keeps worker-context text bounds UTF-16 safe", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Bound context",
      metadata: {
        comments: [
          {
            id: "comment-1",
            body: `${"x".repeat(398)}🚀tail`,
            createdAt: 10,
          },
        ],
      },
    });

    await expect(store.buildWorkerContext(card.id)).resolves.toContain(`- ${"x".repeat(398)}…`);
  });

  it("scopes idempotent creates and stats by board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops work",
      boardId: "ops",
      idempotencyKey: "same",
    });
    const product = await store.create({
      title: "Product work",
      boardId: "product",
      idempotencyKey: "same",
    });
    const repeatedOps = await store.create({
      title: "Duplicate ops",
      boardId: "ops",
      idempotencyKey: "same",
    });

    expect(repeatedOps.id).toBe(ops.id);
    expect(product.id).not.toBe(ops.id);
    await expect(store.list({ boardId: "ops" })).resolves.toHaveLength(1);
    await expect(store.listBoards()).resolves.toMatchObject({
      boards: expect.arrayContaining([
        expect.objectContaining({ id: "ops", total: 1 }),
        expect.objectContaining({ id: "product", total: 1 }),
      ]),
    });
    await expect(store.stats({ boardId: "product" })).resolves.toMatchObject({
      id: "product",
      total: 1,
      byStatus: { todo: 1 },
    });
    const prototypeAgentId = ["__", "proto__"].join("");
    await store.create({
      title: "Prototype safe",
      boardId: "product",
      agentId: prototypeAgentId,
    });
    const stats = await store.stats({ boardId: "product" });
    expect(stats.byAgent[prototypeAgentId]).toBe(1);
  });

  it("rejects completed manifests for cards not created from the parent", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "running" });
    const unrelated = await store.create({ title: "Unrelated" });

    await expect(
      store.complete(parent.id, { createdCardIds: [unrelated.id] }, null),
    ).rejects.toThrow(/not linked/);
    const spoofed = await store.create({
      title: "Spoofed",
      createdByCardId: parent.id,
    });

    await expect(store.complete(parent.id, { createdCardIds: [spoofed.id] }, null)).rejects.toThrow(
      /not linked/,
    );

    const child = await store.create({ title: "Child", parents: [parent.id] });

    await expect(
      store.complete(parent.id, { createdCardIds: [child.id], summary: "done" }, null),
    ).resolves.toMatchObject({
      status: "done",
      metadata: { automation: { createdCardIds: [child.id] } },
    });
  });

  it("promotes, reassigns, and reclaims cards for operator recovery", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Recover me",
      status: "blocked",
      agentId: "old-agent",
      metadata: { failureCount: 2 },
    });
    await store.refreshDiagnostics(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const reassigned = await store.reassign(card.id, {
      agentId: "new-agent",
      status: "todo",
      reason: "route to fresh agent",
    });
    expect(reassigned).toMatchObject({
      agentId: "new-agent",
      status: "todo",
    });
    expect(reassigned.metadata?.failureCount).toBeUndefined();
    expect(reassigned.metadata?.diagnostics?.map((entry) => entry.kind) ?? []).not.toContain(
      "repeated_failures",
    );

    await expect(store.promote(card.id)).resolves.toMatchObject({ status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "new-agent" });

    const reclaimed = await store.reclaim(claimed.card.id, { reason: "stale session" }, null);
    expect(reclaimed).toMatchObject({ status: "ready" });
    expect(reclaimed.metadata?.claim).toBeUndefined();

    const running = await store.create({
      title: "Running recovery",
      status: "running",
      execution: {
        id: "exec-reclaim",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 100,
        updatedAt: 100,
      },
    });
    const stopped = await store.reclaim(running.id, { reason: "replace worker" }, null);
    expect(stopped.execution).toBeUndefined();
    expect(stopped.metadata?.attempts).toEqual([expect.objectContaining({ status: "stopped" })]);
    expect(stopped.metadata?.failureCount).toBeUndefined();
  });

  it("includes parent results and recent assignee work in worker context", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Design",
      status: "running",
      agentId: "agent-a",
    });
    await store.complete(parent.id, { summary: "Use board-scoped queues." }, null);
    await store.create({
      title: "Older task",
      status: "done",
      agentId: "agent-a",
      metadata: { automation: { summary: "Finished related cleanup." } },
    });
    const child = await store.create({
      title: "Implement",
      agentId: "agent-a",
      parents: [parent.id],
    });

    const context = await store.buildWorkerContext(child.id);

    expect(context).toContain("## Parent results");
    expect(context).toContain("Use board-scoped queues.");
    expect(context).toContain("## Recent done work by agent-a");
    expect(context).toContain("Finished related cleanup.");

    const crossBoardChild = await store.create({
      title: "Cross-board child",
      boardId: "product",
      parents: [parent.id],
    });

    await expect(store.buildWorkerContext(crossBoardChild.id)).resolves.toContain(
      "Use board-scoped queues.",
    );
  });

  it("persists board metadata and notification subscriptions in separate stores", async () => {
    const cards = createMemoryStore();
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>();
    const store = new WorkboardStore(cards, { boards, subscriptions });

    const board = await store.upsertBoard({
      id: "ops",
      name: "Ops",
      description: "Operational work",
      defaultWorkspace: { kind: "dir", path: "/tmp/openclaw-ops" },
    });
    const card = await store.create({ title: "Ops card", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed", "failed"],
    });

    await expect(boards.lookup("ops")).resolves.toMatchObject({
      version: 1,
      board: { id: "ops", name: "Ops", description: "Operational work" },
    });
    await expect(subscriptions.lookup(subscription.id)).resolves.toMatchObject({
      version: 1,
      subscription: {
        id: subscription.id,
        boardId: "ops",
        cardId: card.id,
        target: "session:operator",
        eventKinds: ["completed", "failed"],
      },
    });
    await expect(cards.lookup("ops")).resolves.toBeUndefined();
    expect(board.defaultWorkspace).toEqual({ kind: "dir", path: "/tmp/openclaw-ops" });
    expect((await store.listBoards()).boards.find((item) => item.id === "ops")).toMatchObject({
      name: "Ops",
      total: 1,
      active: 1,
      byStatus: { todo: 1 },
    });
    await expect(store.listNotificationSubscriptions({ boardId: "ops" })).resolves.toMatchObject({
      subscriptions: [expect.objectContaining({ id: subscription.id, cardId: card.id })],
    });
  });

  it("replays notification events with subscription cursors", async () => {
    const subscriptions = createMemoryStore<PersistedWorkboardNotificationSubscription>();
    const store = new WorkboardStore(createMemoryStore(), { subscriptions });
    const card = await store.create({ title: "Notify me", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await store.complete(card.id, { summary: "Done." });

    const preview = await store.notificationEvents({ subscriptionId: subscription.id });
    expect(preview.events).toEqual([expect.objectContaining({ kind: "completed" })]);
    const storedPreview = await subscriptions.lookup(subscription.id);
    expect(storedPreview?.subscription).not.toHaveProperty("lastEventAt");
    expect(storedPreview?.subscription).not.toHaveProperty("lastEventId");

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
    });
    expect(first.events).toEqual([expect.objectContaining({ kind: "completed" })]);
    const event = first.events[0];
    if (!event) {
      throw new Error("expected notification event");
    }
    await expect(subscriptions.lookup(subscription.id)).resolves.toMatchObject({
      subscription: {
        lastEventAt: event.createdAt,
        lastEventId: event.id,
      },
    });
    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [],
    });
    await expect(store.notificationEvents({ subscriptionId: "missing" })).rejects.toThrow(
      /subscription not found/,
    );
    await expect(store.advanceNotificationEvents({ boardId: "ops" })).rejects.toThrow(
      /subscriptionId is required/,
    );
  });

  it("does not skip same-millisecond notification events after cursor advancement", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.create({
      title: "First same-ms event",
      boardId: "ops",
      metadata: {
        notifications: [
          {
            id: "z-event",
            kind: "completed",
            createdAt: 1234,
            sequence: 1234000,
            message: "First",
          },
        ],
      },
    });
    await store.create({
      title: "Second same-ms event",
      boardId: "ops",
      metadata: {
        notifications: [
          {
            id: "a-event",
            kind: "completed",
            createdAt: 1234,
            sequence: 1234001,
            message: "Second",
          },
        ],
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
      limit: 1,
    });
    expect(first.events).toEqual([expect.objectContaining({ id: "z-event" })]);

    const second = await store.notificationEvents({ subscriptionId: subscription.id });
    expect(second.events).toEqual([expect.objectContaining({ id: "a-event" })]);
  });

  it("drains large same-millisecond notification batches without replaying delivered ids", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    for (let index = 0; index < 205; index += 1) {
      await store.create({
        title: `Same-ms event ${index}`,
        boardId: "ops",
        metadata: {
          notifications: [
            {
              id: `event-${index}`,
              kind: "completed",
              createdAt: 1234,
              sequence: 1234000 + index,
              message: `Event ${index}`,
            },
          ],
        },
      });
    }
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const first = await store.advanceNotificationEvents({
      subscriptionId: subscription.id,
      limit: 200,
    });
    expect(first.events).toHaveLength(200);
    const second = await store.advanceNotificationEvents({ subscriptionId: subscription.id });
    expect(second.events).toHaveLength(5);
    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [],
    });
  });

  it("filters replayed notification events by session and run subscriptions", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    const matching = await store.create({
      title: "Matching session",
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
    });
    const unrelated = await store.create({
      title: "Other session",
      boardId: "ops",
      sessionKey: "session-2",
      runId: "run-2",
    });
    await store.create({
      title: "Card-scoped failed notification",
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      metadata: {
        notifications: [
          {
            id: "card-scoped-failed",
            kind: "failed",
            createdAt: 1234,
            message: "Dispatch failed before stamping event scope.",
          },
        ],
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      target: "session:operator",
    });

    await store.complete(unrelated.id, { summary: "Other done." });
    await store.complete(matching.id, { summary: "Matching done." });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [
        expect.objectContaining({ id: "card-scoped-failed" }),
        expect.objectContaining({ sessionKey: "session-1", runId: "run-1" }),
      ],
    });
  });

  it("replays card-scoped subscriptions without requiring the board id", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    const card = await store.create({ title: "Ops card", boardId: "ops" });
    const subscription = await store.subscribeNotifications({
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await store.complete(card.id, { summary: "Ops done." });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id, cardId: card.id }),
      events: [expect.objectContaining({ kind: "completed" })],
    });
  });

  it("replays stale metadata as stale notification events", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.create({
      title: "Stale card",
      boardId: "ops",
      metadata: {
        stale: {
          detectedAt: 1234,
          reason: "Session has not reported recent activity.",
        },
      },
    });
    const subscription = await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["stale"],
    });

    await expect(store.notificationEvents({ subscriptionId: subscription.id })).resolves.toEqual({
      subscription: expect.objectContaining({ id: subscription.id }),
      events: [
        expect.objectContaining({
          id: expect.stringContaining("stale:"),
          kind: "stale",
          createdAt: 1234,
        }),
      ],
    });
  });

  it("marks triage cards as orchestration candidates during dispatch", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore(), { boards });
    await store.upsertBoard({
      id: "planning",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const first = await store.create({
      title: "Break down import flow",
      status: "triage",
      boardId: "planning",
    });
    const archived = await store.create({
      title: "Archived import flow",
      status: "triage",
      boardId: "planning",
    });
    await store.archive(archived.id, true);
    const second = await store.create({
      title: "Break down export flow",
      status: "triage",
      boardId: "planning",
    });

    const dispatch = await store.dispatch(10);

    expect(dispatch.orchestrated).toEqual([
      expect.objectContaining({ id: first.id, status: "triage" }),
    ]);
    expect(dispatch.count).toBe(1);
    await expect(store.get(first.id)).resolves.toMatchObject({
      metadata: {
        workerProtocol: {
          state: "idle",
          detail: "Awaiting workboard_specify or workboard_decompose.",
        },
        workerLogs: [expect.objectContaining({ level: "info" })],
      },
      events: expect.arrayContaining([expect.objectContaining({ kind: "orchestration" })]),
    });
    await expect(store.get(second.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
    await expect(store.get(archived.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
  });

  it("applies auto orchestration dispatch caps per board", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore(), { boards });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    await store.upsertBoard({
      id: "product",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const ops = await store.create({ title: "Ops rough", status: "triage", boardId: "ops" });
    const product = await store.create({
      title: "Product rough",
      status: "triage",
      boardId: "product",
    });

    const dispatch = await store.dispatch(10);

    expect(dispatch.orchestrated.map((card) => card.id).toSorted()).toEqual(
      [ops.id, product.id].toSorted(),
    );
  });

  it("scopes dispatch mutations by board", async () => {
    const boards = createMemoryStore<PersistedWorkboardBoard>();
    const store = new WorkboardStore(createMemoryStore(), { boards });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    await store.upsertBoard({
      id: "product",
      orchestration: { autoDecompose: true, autoDecomposePerDispatch: 1 },
    });
    const ops = await store.create({ title: "Ops rough", status: "triage", boardId: "ops" });
    const product = await store.create({
      title: "Product rough",
      status: "triage",
      boardId: "product",
    });

    const dispatch = await store.dispatch({ now: 10, boardId: "ops" });

    expect(dispatch.orchestrated.map((card) => card.id)).toEqual([ops.id]);
    await expect(store.get(ops.id)).resolves.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
    await expect(store.get(product.id)).resolves.not.toMatchObject({
      metadata: { workerProtocol: expect.any(Object) },
    });
  });

  it("deletes board notification subscriptions with empty board metadata", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      boards: createMemoryStore<PersistedWorkboardBoard>(),
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    await store.upsertBoard({ id: "ops", name: "Ops" });
    await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await expect(store.deleteBoard("ops")).resolves.toEqual({ deleted: true });
    await expect(store.listNotificationSubscriptions({ boardId: "ops" })).resolves.toEqual({
      subscriptions: [],
    });
  });

  it("deletes card notification subscriptions with the card", async () => {
    const store = new WorkboardStore(createMemoryStore(), {
      subscriptions: createMemoryStore<PersistedWorkboardNotificationSubscription>(),
    });
    const card = await store.create({ title: "Notify me" });
    await store.subscribeNotifications({
      cardId: card.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await expect(store.delete(card.id)).resolves.toEqual({ deleted: true });
    await expect(store.listNotificationSubscriptions({ cardId: card.id })).resolves.toEqual({
      subscriptions: [],
    });
  });

  it("specifies and decomposes rough cards into linked children", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Rough idea",
      status: "triage",
      boardId: "planning",
      tenant: "qa",
      idempotencyKey: "planning:rough",
    });

    const specified = await store.specify(parent.id, {
      title: "Clarified plan",
      notes: "Acceptance: two concrete follow-up cards.",
      summary: "Clarified the outcome and acceptance criteria.",
      labels: ["planning"],
    });
    expect(specified).toMatchObject({
      title: "Clarified plan",
      status: "todo",
      notes: "Acceptance: two concrete follow-up cards.",
      labels: ["planning"],
      metadata: {
        comments: [
          expect.objectContaining({ body: "Clarified the outcome and acceptance criteria." }),
        ],
      },
    });
    expect(specified.events?.at(-1)).toMatchObject({ kind: "specified" });

    const result = await store.decompose(specified.id, {
      summary: "Split into implementation and review.",
      children: [
        { title: "Implement SQLite persistence", priority: "high" },
        { title: "Review Workboard flows", agentId: "reviewer" },
      ],
    });

    expect(result.parent.status).toBe("done");
    expect(result.parent.events?.at(-1)).toMatchObject({ kind: "decomposed" });
    expect(result.parent.metadata?.automation?.createdCardIds).toEqual(
      result.children.map((child) => child.id),
    );
    expect(result.children).toEqual([
      expect.objectContaining({
        title: "Implement SQLite persistence",
        priority: "high",
        metadata: {
          automation: expect.objectContaining({
            boardId: "planning",
            tenant: "qa",
            createdByCardId: parent.id,
            idempotencyKey: "planning:rough:child:1",
          }),
          links: expect.arrayContaining([
            expect.objectContaining({ type: "parent", targetCardId: parent.id }),
          ]),
        },
      }),
      expect.objectContaining({
        title: "Review Workboard flows",
        agentId: "reviewer",
      }),
    ]);
    await expect(store.runs(parent.id)).resolves.toMatchObject({
      card: { id: parent.id },
      attempts: [],
    });
  });

  it("keeps specify as a todo-only clarification step", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Rough idea", status: "triage" });
    const blocked = await store.create({ title: "Blocked idea", status: "blocked" });

    await expect(store.specify(card.id, { status: "done" })).rejects.toThrow(/must move to todo/);
    await expect(store.specify(card.id, { status: "running" })).rejects.toThrow(
      /must move to todo/,
    );
    await expect(store.specify(blocked.id, { title: "Specified" })).rejects.toThrow(
      /only triage, backlog, or todo/,
    );
    await expect(store.specify(card.id, { title: "Specified" })).resolves.toMatchObject({
      title: "Specified",
      status: "todo",
    });
  });

  it("rolls back newly created children when decomposition fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "todo" });

    await expect(
      store.decompose(parent.id, {
        children: [{ title: "First child" }, { notes: "Missing title" }],
      }),
    ).rejects.toThrow(/title is required/);

    await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: parent.id })]);
    expect((await store.get(parent.id))?.metadata?.links).toBeUndefined();
  });

  it("rolls back links added to reused idempotent children when decomposition fails", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent" });
    const existingChild = await store.create({
      title: "Existing child",
      status: "ready",
      idempotencyKey: "child-key",
    });
    await store.addLink(existingChild.id, { type: "relates_to", targetCardId: parent.id });

    await expect(
      store.decompose(parent.id, {
        children: [
          { title: "Existing child", idempotencyKey: "child-key" },
          { notes: "Missing title" },
        ],
      }),
    ).rejects.toThrow(/title is required/);

    await expect(store.list()).resolves.toHaveLength(2);
    expect((await store.get(parent.id))?.metadata?.links).toBeUndefined();
    await expect(store.get(existingChild.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        links: [expect.objectContaining({ type: "relates_to", targetCardId: parent.id })],
      },
    });
  });

  it("preserves parent child links when decomposition leaves the parent open", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({ title: "Parent", status: "triage" });
    await store.addLink(parent.id, { type: "relates_to", url: "https://example.com/context" });

    const result = await store.decompose(parent.id, {
      completeParent: false,
      summary: "Split and keep parent open.",
      children: [{ title: "Child" }],
    });

    expect(result.parent.status).toBe("todo");
    expect(result.parent.metadata?.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "relates_to", url: "https://example.com/context" }),
        expect.objectContaining({ type: "child", targetCardId: result.children[0]?.id }),
      ]),
    );
    await expect(
      store.complete(parent.id, {
        createdCardIds: result.children.map((child) => child.id),
        summary: "Children recorded.",
      }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("omits derived child idempotency keys when the parent key is already at the limit", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Parent",
      idempotencyKey: "p".repeat(160),
    });

    const result = await store.decompose(parent.id, {
      children: [{ title: "Child" }],
    });

    expect(result.children[0]?.metadata?.automation?.idempotencyKey).toBeUndefined();
  });

  it("links an idempotent existing child before completing decomposition", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const existingChild = await store.create({
      title: "Existing child",
      idempotencyKey: "child-key",
    });
    const parent = await store.create({ title: "Parent" });

    const result = await store.decompose(parent.id, {
      children: [{ title: "Ignored duplicate", idempotencyKey: "child-key" }],
    });

    expect(result.parent.status).toBe("done");
    expect(result.children).toEqual([expect.objectContaining({ id: existingChild.id })]);
    expect(result.parent.metadata?.automation?.createdCardIds).toEqual([existingChild.id]);
    await expect(store.get(existingChild.id)).resolves.toMatchObject({
      metadata: {
        links: expect.arrayContaining([
          expect.objectContaining({ type: "parent", targetCardId: parent.id }),
        ]),
      },
    });
  });

  it("rejects invalid status values", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await expect(store.create({ title: "Bad card", status: "later" })).rejects.toThrow(
      /status must be one of/,
    );
  });
});

// ---- AUT-WB-ATOMIC server boundary (contract aut-wb-atomic/1, child aut-wb-atomic-server/1)

import { createHash } from "node:crypto";
import {
  atomicCardNotes,
  atomicCardTitle,
  atomicSpecFingerprint,
  buildAtomicEnvelope,
  canonicalAtomicJson,
  deriveAtomicOccurrenceKey,
  isAtomicCorrelationKey,
  validateAtomicCreateRequest,
} from "./store.js";
import type { AtomicCreateResponseV1, CanonicalAutomationCardSpecV1 } from "./types.js";

const FROZEN_KEY = "occ_v1_7a80f585e84b83e031d3eb8823faaee0";
const FROZEN_FINGERPRINT =
  "sha256:952ae4aac535d4220eea7ec6d33c065cb80446e1924c922861802eff62773c6b";
// Complete frozen canonical byte string for the parent contract §3.2 example. The
// assertion below is byte-exact on purpose: a placeholder or self-derived expectation
// does not satisfy the §3.4 vector.
const FROZEN_CANONICAL_JSON =
  '{"automation":{"approval_policy":"operator-required","automation_id":"aut-test.daily-brief","occurrence_key":"occ_v1_7a80f585e84b83e031d3eb8823faaee0","output_contract_ref":"contracts/output/daily-brief@1","risk_class":"read-only","schedule_revision":1,"scheduled_at":"2026-08-03T12:00:00.000Z","skill_name":"workboard-worker","skill_version":"1.2.0","verification_contract_ref":"contracts/verify/daily-brief@1"},"board":{"id":"test-board","lane":"automation","ref":"board:test-board","template_ref":null},"execution_control":{"assignee_id":null,"claim_owner_id":null,"execution_authorized":false,"execution_id":null},"initial_status":"backlog","labels":["automation","hold","operator-merge-only"],"notes":"Governed automation occurrence; occurrence_key=occ_v1_7a80f585e84b83e031d3eb8823faaee0; automation_id=aut-test.daily-brief; schedule_revision=1; scheduled_at=2026-08-03T12:00:00.000Z; skill=workboard-worker@1.2.0; risk_class=read-only; approval_policy=operator-required; output_contract_ref=contracts/output/daily-brief@1; verification_contract_ref=contracts/verify/daily-brief@1; held=true; operator_controlled=true; execution_authorized=false.","priority":"normal","schema_version":1,"title":"Automation aut-test.daily-brief @ 2026-08-03T12:00:00.000Z"}';

type AtomicSpecOverrides = {
  automation?: Partial<CanonicalAutomationCardSpecV1["automation"]>;
  top?: Partial<Record<string, unknown>>;
};

function makeAtomicSpec(
  automationId = "aut-test.daily-brief",
  scheduledAt = "2026-08-03T12:00:00.000Z",
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

function openAtomicFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-store-"));
  const dbPath = path.join(dir, "workboard.sqlite");
  const stores = createWorkboardSqliteStores({ dbPath });
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
  });
  return {
    dir,
    dbPath,
    stores,
    store,
    close() {
      stores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type AtomicGatewayHandler = Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];

function captureAtomicGatewayHandler(store: WorkboardStore): AtomicGatewayHandler {
  const methods = new Map<string, AtomicGatewayHandler>();
  const api = {
    registerGatewayMethod: vi.fn((method: string, handler: AtomicGatewayHandler) => {
      methods.set(method, handler);
    }),
  } as unknown as OpenClawPluginApi;
  registerWorkboardGatewayMethods({ api, store });
  const handler = methods.get("workboard.cards.createOrRecoverByCorrelationKey");
  expect(handler).toBeDefined();
  return handler as AtomicGatewayHandler;
}

async function invokeAtomicGateway(
  handler: AtomicGatewayHandler,
  params: Record<string, unknown>,
): Promise<AtomicCreateResponseV1> {
  const respond = vi.fn();
  await handler({ params, respond } as never);
  expect(respond).toHaveBeenCalledOnce();
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return respond.mock.calls[0]?.[1] as AtomicCreateResponseV1;
}

const PROHIBITED_ATOMIC_EFFECT_METHODS = [
  "list",
  "get",
  "create",
  "update",
  "bulkUpdate",
  "move",
  "delete",
  "claim",
  "heartbeat",
  "releaseClaim",
  "promote",
  "promoteReady",
  "reassign",
  "reclaim",
  "complete",
  "block",
  "unblock",
  "dispatch",
] as const;

function poisonProhibitedAtomicEffects(store: WorkboardStore) {
  return PROHIBITED_ATOMIC_EFFECT_METHODS.map((method) =>
    vi
      .spyOn(store as unknown as Record<string, (...args: never[]) => unknown>, method)
      .mockImplementation(() => {
        throw new Error(`prohibited atomic effect reached: ${method}`);
      }),
  );
}

function poisonGenericStoreFallbacks(store: {
  register: (...args: never[]) => unknown;
  lookup: (...args: never[]) => unknown;
  delete: (...args: never[]) => unknown;
  entries: (...args: never[]) => unknown;
}) {
  return (["register", "lookup", "delete", "entries"] as const).map((method) =>
    vi.spyOn(store, method).mockImplementation(() => {
      throw new Error(`generic store fallback reached: ${method}`);
    }),
  );
}

// Full no-mutation oracle: the card row plus EVERY child-data surface (all twelve
// child tables) and attachment blob bytes.
const RAW_DIGEST_CHILD_TABLES = [
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

function rawDigest(dbPath: string, cardId: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const card = db.prepare("SELECT * FROM workboard_cards WHERE id = ?").get(cardId);
    const children = RAW_DIGEST_CHILD_TABLES.map((table) =>
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

function receiptCount(dbPath: string, key: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM workboard_atomic_create_receipts WHERE correlation_key = ?",
      )
      .get(key) as { n: number | bigint };
    return Number(row.n);
  } finally {
    db.close();
  }
}

function totalReceiptCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM workboard_atomic_create_receipts").get() as {
      n: number | bigint;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

// Corrupting stored records requires bypassing the immutability trigger the way a
// hostile writer would, then restoring the trigger so the schema stays complete.
function corruptCorrelatedRow(dbPath: string, mutate: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("DROP TRIGGER workboard_cards_atomic_tuple_immutable");
    db.exec("DROP TRIGGER workboard_cards_atomic_tuple_complete_update");
    mutate(db);
    db.exec(`
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
    `);
  } finally {
    db.close();
  }
}

describe("AUT-WB-ATOMIC frozen vectors", () => {
  it("derives the frozen occurrence key from the frozen material", () => {
    expect(deriveAtomicOccurrenceKey("aut-test.daily-brief", 1, "2026-08-03T12:00:00.000Z")).toBe(
      FROZEN_KEY,
    );
    const material = "veelo-aut-occ|v1|aut-test.daily-brief|rev1|2026-08-03T12:00:00.000Z";
    expect(
      `occ_v1_${createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32)}`,
    ).toBe(FROZEN_KEY);
  });

  it("canonicalizes the §3.2 example to the exact frozen byte string and fingerprint", () => {
    const { key, spec } = makeAtomicSpec();
    expect(key).toBe(FROZEN_KEY);
    const validated = validateAtomicCreateRequest(key, spec);
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }
    expect(validated.canonicalJson).toBe(FROZEN_CANONICAL_JSON);
    expect(validated.fingerprint).toBe(FROZEN_FINGERPRINT);
    expect(atomicSpecFingerprint(FROZEN_CANONICAL_JSON)).toBe(FROZEN_FINGERPRINT);
  });

  it("one-byte mutations change the digest and one-field mutations change the fingerprint", () => {
    const flipped = `${FROZEN_CANONICAL_JSON.slice(0, 100)}${
      FROZEN_CANONICAL_JSON[100] === "a" ? "b" : "a"
    }${FROZEN_CANONICAL_JSON.slice(101)}`;
    expect(atomicSpecFingerprint(flipped)).not.toBe(FROZEN_FINGERPRINT);
    const mutated = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z", 1, {
      automation: { skill_version: "1.2.1" },
    });
    const validated = validateAtomicCreateRequest(mutated.key, mutated.spec);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.fingerprint).not.toBe(FROZEN_FINGERPRINT);
    }
  });

  it("isAtomicCorrelationKey enforces the frozen grammar", () => {
    expect(isAtomicCorrelationKey(FROZEN_KEY)).toBe(true);
    for (const bad of [
      null,
      42,
      "occ_v1_",
      "occ_v2_7a80f585e84b83e031d3eb8823faaee0",
      "occ_v1_7A80F585E84B83E031D3EB8823FAAEE0",
      `${FROZEN_KEY}0`,
      FROZEN_KEY.slice(0, 38),
    ]) {
      expect(isAtomicCorrelationKey(bad)).toBe(false);
    }
  });
});

describe("AUT-WB-ATOMIC request validation (A14-A22)", () => {
  function expectInvalid(key: unknown, spec: unknown, expectedKeyEcho?: string | null) {
    const result = validateAtomicCreateRequest(key, spec);
    expect(result.ok).toBe(false);
    if (!result.ok && expectedKeyEcho !== undefined) {
      expect(result.correlationKey).toBe(expectedKeyEcho);
    }
  }

  it("accepts only the exact closed shape", () => {
    const { key, spec } = makeAtomicSpec();
    expect(validateAtomicCreateRequest(key, spec).ok).toBe(true);
  });

  it("rejects malformed keys and non-object specs with a null key echo when key-invalid", () => {
    const { key, spec } = makeAtomicSpec();
    expectInvalid(null, spec, null);
    expectInvalid("occ_v1_zzz", spec, null);
    expectInvalid(key, null, key);
    expectInvalid(key, [], key);
    expectInvalid(key, "spec", key);
  });

  it("rejects unknown and missing fields at every level (A22)", () => {
    const { key, spec } = makeAtomicSpec();
    const levels: Array<[string, (clone: Record<string, any>) => void]> = [
      ["top unknown", (c) => (c.extra = 1)],
      ["top missing", (c) => delete c.priority],
      ["board unknown", (c) => (c.board.extra = 1)],
      ["board missing", (c) => delete c.board.lane],
      ["automation unknown", (c) => (c.automation.extra = 1)],
      ["automation missing", (c) => delete c.automation.skill_name],
      ["execution unknown", (c) => (c.execution_control.extra = 1)],
      ["execution missing", (c) => delete c.execution_control.execution_id],
    ];
    for (const [, mutate] of levels) {
      const clone = structuredClone(spec) as Record<string, any>;
      mutate(clone);
      expectInvalid(key, clone, key);
    }
  });

  it("rejects each fixed and derived field mutation (A14-A17)", () => {
    const { key, spec } = makeAtomicSpec();
    const mutations: Array<(clone: Record<string, any>) => void> = [
      (c) => (c.title = "Tampered title"),
      (c) => (c.initial_status = "todo"),
      (c) => (c.priority = "high"),
      (c) => (c.labels = ["automation", "hold", "operator-merge-only", "extra"]),
      (c) => (c.labels = ["automation", "hold"]),
      (c) => (c.labels = ["hold", "automation", "operator-merge-only"]),
      (c) => (c.notes = `${c.notes} tampered`),
      (c) => (c.execution_control.assignee_id = "agent-1"),
      (c) => (c.execution_control.claim_owner_id = "owner-1"),
      (c) => (c.execution_control.execution_id = "exec-1"),
      (c) => (c.execution_control.execution_authorized = true),
      (c) => (c.schema_version = 2),
    ];
    for (const mutate of mutations) {
      const clone = structuredClone(spec) as Record<string, any>;
      mutate(clone);
      expectInvalid(key, clone, key);
    }
  });

  it("rejects occurrence-key derivation mismatches (A18-A20)", () => {
    const base = makeAtomicSpec();
    // Same external key, changed automation identity fields with re-derived title/notes.
    const changedId = makeAtomicSpec("aut-test.other-brief");
    const changedIdSpec = structuredClone(changedId.spec) as Record<string, any>;
    changedIdSpec.automation.occurrence_key = base.key;
    changedIdSpec.notes = atomicCardNotes(changedIdSpec.automation);
    expectInvalid(base.key, changedIdSpec, base.key);
    const changedRev = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z", 2);
    const changedRevSpec = structuredClone(changedRev.spec) as Record<string, any>;
    changedRevSpec.automation.occurrence_key = base.key;
    changedRevSpec.notes = atomicCardNotes(changedRevSpec.automation);
    expectInvalid(base.key, changedRevSpec, base.key);
    const changedAt = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T13:00:00.000Z");
    const changedAtSpec = structuredClone(changedAt.spec) as Record<string, any>;
    changedAtSpec.automation.occurrence_key = base.key;
    changedAtSpec.notes = atomicCardNotes(changedAtSpec.automation);
    expectInvalid(base.key, changedAtSpec, base.key);
    // Key/spec disagreement in either direction.
    const clone = structuredClone(base.spec) as Record<string, any>;
    expectInvalid(changedAt.key, clone, changedAt.key);
  });

  it("rejects grammar, namespace, policy-matrix, timestamp, and secret-shape violations", () => {
    const { key, spec } = makeAtomicSpec();
    const cases: Array<(clone: Record<string, any>) => void> = [
      (c) => (c.board.id = "Bad_Board"),
      (c) => (c.board.ref = "board:other-board"),
      (c) => (c.board.lane = "UPPER"),
      (c) => (c.board.template_ref = "contracts/output/x@1"),
      (c) => (c.board.template_ref = "workboard:template/"),
      (c) => (c.automation.skill_name = "Bad Skill"),
      (c) => (c.automation.skill_version = "1.2"),
      (c) => (c.automation.risk_class = "critical"),
      (c) => (c.automation.approval_policy = "self-approved"),
      (c) => {
        c.automation.risk_class = "external-effect";
        c.automation.approval_policy = "auto-within-risk-class";
        c.notes = atomicCardNotes(c.automation);
      },
      (c) => (c.automation.output_contract_ref = "contracts/verify/daily-brief@1"),
      (c) => (c.automation.verification_contract_ref = "contracts/output/daily-brief@1"),
      (c) => (c.automation.output_contract_ref = "reports/output/daily-brief@1"),
      (c) => (c.automation.schedule_revision = 0),
      (c) => (c.automation.schedule_revision = 1.5),
    ];
    for (const mutate of cases) {
      const clone = structuredClone(spec) as Record<string, any>;
      mutate(clone);
      expectInvalid(key, clone, key);
    }
    // Non-canonical timestamp with a consistently derived key is still invalid.
    const nonCanonical = "2026-08-03T12:00:00Z";
    const derived = deriveAtomicOccurrenceKey("aut-test.daily-brief", 1, nonCanonical);
    const clone = structuredClone(spec) as Record<string, any>;
    clone.automation.scheduled_at = nonCanonical;
    clone.automation.occurrence_key = derived;
    clone.title = atomicCardTitle("aut-test.daily-brief", nonCanonical);
    clone.notes = atomicCardNotes(clone.automation);
    expectInvalid(derived, clone, derived);
    // Token-shaped reference value is refused by the deep secret scan.
    const secretClone = structuredClone(spec) as Record<string, any>;
    const tokenShape = ["ghp", "A".repeat(20)].join("_");
    secretClone.board.template_ref = `workboard:template/${tokenShape}`;
    expectInvalid(key, secretClone, key);
  });
});

describe("AUT-WB-ATOMIC A22 closed-request persisted-invariant proof", () => {
  type A22Case = {
    label: string;
    expectedCorrelationKey: string | null;
    params: (key: string, spec: CanonicalAutomationCardSpecV1) => Record<string, unknown>;
  };

  function mutatedSpec(
    spec: CanonicalAutomationCardSpecV1,
    mutate: (clone: Record<string, any>) => void,
  ): Record<string, unknown> {
    const clone = structuredClone(spec) as Record<string, any>;
    mutate(clone);
    return clone;
  }

  it("rejects unknown and missing fields at every request/spec authority level before lookup or write", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(created.reason_code).toBe("workboard_card_created");
      const cardId = created.card?.id as string;
      const handler = captureAtomicGatewayHandler(fixture.store);
      const invariantBefore = rawDigest(fixture.dbPath, cardId);
      const receiptsBefore = totalReceiptCount(fixture.dbPath);
      const atomicBoundarySpy = vi.spyOn(
        fixture.stores.cards as unknown as {
          atomicCreateOrRecover: (...args: never[]) => unknown;
        },
        "atomicCreateOrRecover",
      );
      const effectSpies = poisonProhibitedAtomicEffects(fixture.store);
      const fallbackSpies = poisonGenericStoreFallbacks(fixture.stores.cards);
      const cases: A22Case[] = [
        {
          label: "unknown top-level request field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: requestSpec,
            unknown_request_field: true,
          }),
        },
        {
          label: "missing top-level correlationKey",
          expectedCorrelationKey: null,
          params: (_requestKey, requestSpec) => ({ cardSpec: requestSpec }),
        },
        {
          label: "missing top-level cardSpec",
          expectedCorrelationKey: key,
          params: (requestKey) => ({ correlationKey: requestKey }),
        },
        {
          label: "unknown cardSpec field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              clone.unknown_spec_field = true;
            }),
          }),
        },
        {
          label: "missing required cardSpec field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              delete clone.priority;
            }),
          }),
        },
        {
          label: "unknown automation identity field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              clone.automation.unknown_identity_field = true;
            }),
          }),
        },
        {
          label: "missing required automation identity field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              delete clone.automation.automation_id;
            }),
          }),
        },
        {
          label: "unknown board field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              clone.board.unknown_board_field = true;
            }),
          }),
        },
        {
          label: "missing required board field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              delete clone.board.template_ref;
            }),
          }),
        },
        {
          label: "unknown execution_control field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              clone.execution_control.unknown_execution_field = true;
            }),
          }),
        },
        {
          label: "missing required execution_control field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              delete clone.execution_control.execution_authorized;
            }),
          }),
        },
        {
          label: "unknown nested governance field",
          expectedCorrelationKey: key,
          params: (requestKey, requestSpec) => ({
            correlationKey: requestKey,
            cardSpec: mutatedSpec(requestSpec, (clone) => {
              clone.automation.governance = { unknown_governance_field: true };
            }),
          }),
        },
      ];

      for (const testCase of cases) {
        const result = await invokeAtomicGateway(handler, testCase.params(key, spec));
        expect(result, testCase.label).toEqual({
          schema_version: 1,
          ok: false,
          outcome: "refused",
          reason_code: "workboard_create_request_invalid",
          retryable: false,
          correlation_key: testCase.expectedCorrelationKey,
          card: null,
          stored_spec: null,
          stored_fingerprint: null,
          evidence: null,
        });
        expect(rawDigest(fixture.dbPath, cardId), testCase.label).toBe(invariantBefore);
        expect(totalReceiptCount(fixture.dbPath), testCase.label).toBe(receiptsBefore);
      }

      expect(atomicBoundarySpy).not.toHaveBeenCalled();
      for (const spy of [...effectSpies, ...fallbackSpies]) {
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      }
    } finally {
      vi.restoreAllMocks();
      fixture.close();
    }
  });
});

describe("AUT-WB-ATOMIC recovery, conflicts, and refusals", () => {
  it("A08: identical replay recovers without mutating the card or children", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(created.reason_code).toBe("workboard_card_created");
      const cardId = created.card?.id as string;
      const before = rawDigest(fixture.dbPath, cardId);
      const recovered = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(recovered.reason_code).toBe("workboard_card_recovered");
      expect(recovered.ok).toBe(true);
      expect(recovered.card).toEqual(created.card);
      expect(recovered.stored_spec).toEqual(created.stored_spec);
      expect(recovered.stored_fingerprint).toBe(created.stored_fingerprint);
      expect(recovered.evidence?.ref).not.toBe(created.evidence?.ref);
      expect(rawDigest(fixture.dbPath, cardId)).toBe(before);
      expect(receiptCount(fixture.dbPath, key)).toBe(2);
    } finally {
      fixture.close();
    }
  });

  it("A09-A13, A21: every valid governance mutation conflicts without mutation", async () => {
    const fixture = openAtomicFixture();
    try {
      const base = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(base.key, base.spec);
      const cardId = created.card?.id as string;
      const before = rawDigest(fixture.dbPath, cardId);
      const conflictOverrides: AtomicSpecOverrides[] = [
        { automation: { risk_class: "draft-only" } },
        { automation: { approval_policy: "auto-within-risk-class" } },
        { automation: { skill_name: "other-worker" } },
        { automation: { skill_version: "2.0.0" } },
        { automation: { output_contract_ref: "contracts/output/daily-brief@2" } },
        { automation: { verification_contract_ref: "contracts/verify/daily-brief@2" } },
        {
          top: {
            board: {
              id: "other-board",
              ref: "board:other-board",
              lane: "automation",
              template_ref: null,
            },
          },
        },
        {
          top: {
            board: { id: "test-board", ref: "board:test-board", lane: null, template_ref: null },
          },
        },
        {
          top: {
            board: {
              id: "test-board",
              ref: "board:test-board",
              lane: "automation",
              template_ref: "workboard:template/daily",
            },
          },
        },
      ];
      for (const overrides of conflictOverrides) {
        const mutated = makeAtomicSpec(
          "aut-test.daily-brief",
          "2026-08-03T12:00:00.000Z",
          1,
          overrides,
        );
        const result = await fixture.store.createOrRecoverByCorrelationKey(base.key, mutated.spec);
        expect(result.reason_code).toBe("workboard_card_conflict");
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe("refused");
        expect(result.retryable).toBe(false);
        expect(result.card).toBeNull();
        expect(result.stored_spec).toBeNull();
        expect(result.stored_fingerprint).toBe(created.stored_fingerprint);
        expect(result.evidence?.kind).toBe("workboard_atomic_receipt");
      }
      expect(rawDigest(fixture.dbPath, cardId)).toBe(before);
      // conflict receipts carry both fingerprints
      const db = new DatabaseSync(fixture.dbPath);
      try {
        const rows = db
          .prepare(
            "SELECT request_fingerprint, stored_fingerprint FROM workboard_atomic_create_receipts WHERE reason_code = 'workboard_card_conflict'",
          )
          .all() as Array<{ request_fingerprint: string; stored_fingerprint: string }>;
        expect(rows).toHaveLength(conflictOverrides.length);
        for (const row of rows) {
          expect(row.stored_fingerprint).toBe(created.stored_fingerprint);
          expect(row.request_fingerprint).not.toBe(row.stored_fingerprint);
        }
      } finally {
        db.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("request-invalid precedence: an invalid same-key request never reaches comparison (A14 vs A21)", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      const cardId = created.card?.id as string;
      const before = rawDigest(fixture.dbPath, cardId);
      const receiptsBefore = receiptCount(fixture.dbPath, key);
      const tampered = structuredClone(spec) as Record<string, any>;
      tampered.title = "Tampered";
      const result = await fixture.store.createOrRecoverByCorrelationKey(key, tampered);
      expect(result.reason_code).toBe("workboard_create_request_invalid");
      expect(result.correlation_key).toBe(key);
      expect(result.card).toBeNull();
      expect(result.stored_spec).toBeNull();
      expect(result.stored_fingerprint).toBeNull();
      expect(result.evidence).toBeNull();
      expect(rawDigest(fixture.dbPath, cardId)).toBe(before);
      expect(receiptCount(fixture.dbPath, key)).toBe(receiptsBefore);
    } finally {
      fixture.close();
    }
  });

  it("A23-A25: malformed, forged, or unknown-field stored records fail closed", async () => {
    const cases: Array<{
      detail: string;
      corrupt: (db: DatabaseSync, cardId: string) => void;
    }> = [
      {
        detail: "governance-spec-version-invalid",
        corrupt: (db, cardId) =>
          void db
            .prepare("UPDATE workboard_cards SET governance_spec_version = 2 WHERE id = ?")
            .run(cardId),
      },
      {
        detail: "governance-spec-unreadable",
        corrupt: (db, cardId) =>
          void db
            .prepare("UPDATE workboard_cards SET governance_spec_json = '{broken' WHERE id = ?")
            .run(cardId),
      },
      {
        detail: "governance-spec-invalid",
        corrupt: (db, cardId) =>
          void db
            .prepare("UPDATE workboard_cards SET governance_spec_json = '{}' WHERE id = ?")
            .run(cardId),
      },
      {
        detail: "governance-spec-invalid",
        corrupt: (db, cardId) => {
          const row = db
            .prepare("SELECT governance_spec_json FROM workboard_cards WHERE id = ?")
            .get(cardId) as { governance_spec_json: string };
          const spec = JSON.parse(row.governance_spec_json) as Record<string, unknown>;
          spec.unknown_field = "x";
          db.prepare("UPDATE workboard_cards SET governance_spec_json = ? WHERE id = ?").run(
            JSON.stringify(spec),
            cardId,
          );
        },
      },
      {
        // A25 nested variant (Round-1 proof gap 3): the unknown field hides one
        // level down, inside the automation object.
        detail: "governance-spec-invalid",
        corrupt: (db, cardId) => {
          const row = db
            .prepare("SELECT governance_spec_json FROM workboard_cards WHERE id = ?")
            .get(cardId) as { governance_spec_json: string };
          const spec = JSON.parse(row.governance_spec_json) as {
            automation: Record<string, unknown>;
          };
          spec.automation.unknown_nested = "x";
          db.prepare("UPDATE workboard_cards SET governance_spec_json = ? WHERE id = ?").run(
            JSON.stringify(spec),
            cardId,
          );
        },
      },
      {
        detail: "governance-fingerprint-forged",
        corrupt: (db, cardId) =>
          void db
            .prepare("UPDATE workboard_cards SET governance_fingerprint = ? WHERE id = ?")
            .run(`sha256:${"0".repeat(64)}`, cardId),
      },
      {
        detail: "governance-fingerprint-forged",
        corrupt: (db, cardId) => {
          // Spec changed, fingerprint left as originally expected.
          const forged = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z", 1, {
            automation: { skill_version: "3.0.0" },
          });
          db.prepare("UPDATE workboard_cards SET governance_spec_json = ? WHERE id = ?").run(
            canonicalAtomicJson(forged.spec),
            cardId,
          );
        },
      },
      {
        detail: "governance-fingerprint-unreadable",
        corrupt: (db, cardId) =>
          void db
            .prepare("UPDATE workboard_cards SET governance_fingerprint = 'garbage' WHERE id = ?")
            .run(cardId),
      },
    ];
    for (const testCase of cases) {
      const fixture = openAtomicFixture();
      try {
        const { key, spec } = makeAtomicSpec();
        const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        const cardId = created.card?.id as string;
        corruptCorrelatedRow(fixture.dbPath, (db) => testCase.corrupt(db, cardId));
        const before = rawDigest(fixture.dbPath, cardId);
        const result = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        expect(result.reason_code).toBe("workboard_stored_record_invalid");
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe("refused");
        expect(result.card).toBeNull();
        expect(result.evidence?.kind).toBe("workboard_atomic_receipt");
        expect(rawDigest(fixture.dbPath, cardId)).toBe(before);
        const db = new DatabaseSync(fixture.dbPath);
        try {
          const receipt = db
            .prepare(
              "SELECT detail_code FROM workboard_atomic_create_receipts WHERE reason_code = 'workboard_stored_record_invalid' ORDER BY created_at DESC LIMIT 1",
            )
            .get() as { detail_code: string };
          expect(receipt.detail_code).toBe(testCase.detail);
        } finally {
          db.close();
        }
      } finally {
        fixture.close();
      }
    }
  });

  it("A26-A29: assigned, claimed, executing, started, completed, attempted, drifted, archived cards refuse", async () => {
    const cases: Array<{
      detail: string;
      mutate: (db: DatabaseSync, cardId: string) => void;
    }> = [
      {
        detail: "card-assigned",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET agent_id = 'agent-1' WHERE id = ?").run(id),
      },
      {
        detail: "card-claimed",
        mutate: (db, id) =>
          void db
            .prepare(
              'UPDATE workboard_cards SET claim_json = \'{"ownerId":"o","token":"t","claimedAt":1,"lastHeartbeatAt":1}\' WHERE id = ?',
            )
            .run(id),
      },
      {
        detail: "card-executing",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_id = 'exec-1' WHERE id = ?")
            .run(id),
      },
      // Every persisted execution field independently breaks pristine state
      // (Round-1 defect 3), including the reviewer-reproduced execution_status case.
      {
        detail: "execution-kind-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_kind = 'agent-session' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-engine-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_engine = 'claude' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-mode-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_mode = 'autonomous' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-status-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_status = 'running' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-model-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_model = 'model-x' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-session-key-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_session_key = 'sess-1' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-run-id-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_run_id = 'run-1' WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-started-at-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_started_at = 7 WHERE id = ?")
            .run(id),
      },
      {
        detail: "execution-updated-at-set",
        mutate: (db, id) =>
          void db
            .prepare("UPDATE workboard_cards SET execution_updated_at = 7 WHERE id = ?")
            .run(id),
      },
      {
        detail: "status-not-backlog",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET status = 'running' WHERE id = ?").run(id),
      },
      {
        detail: "card-started",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET started_at = 5 WHERE id = ?").run(id),
      },
      {
        detail: "card-completed",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET completed_at = 5 WHERE id = ?").run(id),
      },
      {
        detail: "card-has-attempts",
        mutate: (db, id) =>
          void db
            .prepare(
              "INSERT INTO workboard_card_attempts (id, card_id, ordinal, status, started_at) VALUES ('a1', ?, 0, 'running', 1)",
            )
            .run(id),
      },
      {
        detail: "labels-drift",
        mutate: (db, id) =>
          void db
            .prepare(
              "INSERT INTO workboard_card_labels (card_id, ordinal, label) VALUES (?, 3, 'extra')",
            )
            .run(id),
      },
      {
        detail: "title-drift",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET title = 'edited' WHERE id = ?").run(id),
      },
      {
        detail: "notes-drift",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET notes = 'edited' WHERE id = ?").run(id),
      },
      {
        detail: "priority-drift",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET priority = 'high' WHERE id = ?").run(id),
      },
      {
        detail: "card-archived",
        mutate: (db, id) =>
          void db.prepare("UPDATE workboard_cards SET archived_at = 5 WHERE id = ?").run(id),
      },
    ];
    for (const testCase of cases) {
      const fixture = openAtomicFixture();
      try {
        const { key, spec } = makeAtomicSpec();
        const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        const cardId = created.card?.id as string;
        const db = new DatabaseSync(fixture.dbPath);
        try {
          testCase.mutate(db, cardId);
        } finally {
          db.close();
        }
        const before = rawDigest(fixture.dbPath, cardId);
        const result = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        expect(result.reason_code).toBe("workboard_card_state_incompatible");
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe("refused");
        expect(result.retryable).toBe(false);
        expect(result.card).toBeNull();
        expect(result.evidence?.kind).toBe("workboard_atomic_receipt");
        expect(rawDigest(fixture.dbPath, cardId)).toBe(before);
        const checkDb = new DatabaseSync(fixture.dbPath);
        try {
          const receipt = checkDb
            .prepare(
              "SELECT detail_code, card_id FROM workboard_atomic_create_receipts WHERE reason_code = 'workboard_card_state_incompatible' ORDER BY created_at DESC LIMIT 1",
            )
            .get() as { detail_code: string; card_id: string };
          expect(receipt.detail_code).toBe(testCase.detail);
          expect(receipt.card_id).toBe(cardId);
        } finally {
          checkDb.close();
        }
      } finally {
        fixture.close();
      }
    }
  });

  it("A30: legacy same-key cards fail closed with no adoption", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      // One legacy card advertising the key through the generic create surface.
      const legacy = await fixture.store.create({
        title: "legacy occurrence card",
        idempotencyKey: key,
      });
      const single = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(single.reason_code).toBe("workboard_incompatible_legacy_card");
      expect(single.ok).toBe(false);
      expect(single.outcome).toBe("refused");
      expect(single.card).toBeNull();
      expect(single.evidence?.kind).toBe("workboard_atomic_receipt");
      // A second legacy advertiser on another board: closed count evidence, no card ids leak.
      await fixture.store.create({
        title: "legacy occurrence card two",
        idempotencyKey: key,
        boardId: "other-board",
      });
      const multiple = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(multiple.reason_code).toBe("workboard_incompatible_legacy_card");
      const db = new DatabaseSync(fixture.dbPath);
      try {
        const rows = db
          .prepare(
            "SELECT card_id, detail_code FROM workboard_atomic_create_receipts WHERE reason_code = 'workboard_incompatible_legacy_card'",
          )
          .all() as Array<{ card_id: string | null; detail_code: string | null }>;
        expect(rows).toHaveLength(2);
        const singleCandidate = rows.find((row) => row.detail_code === null);
        const multiCandidate = rows.find((row) => row.detail_code === "legacy-candidates-2");
        expect(singleCandidate?.card_id).toBe(legacy.id);
        expect(multiCandidate?.card_id).toBeNull();
        const count = db
          .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE correlation_key IS NOT NULL")
          .get() as { n: number | bigint };
        expect(Number(count.n)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("A30/A23: malformed legacy metadata and indexed/legacy mismatch fail closed", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      // Malformed legacy row that mentions the key inside unreadable metadata.
      const db = new DatabaseSync(fixture.dbPath);
      db.prepare(
        `
          INSERT INTO workboard_cards
            (id, board_id, title, status, priority, position, created_at, updated_at, automation_json)
          VALUES ('55555555-5555-4555-8555-555555555555', 'default', 'broken legacy', 'backlog', 'normal', 1, 1, 1, ?)
        `,
      ).run(`{"idempotencyKey": "${key}" BROKEN`);
      db.close();
      const malformed = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(malformed.reason_code).toBe("workboard_stored_record_invalid");
      const db2 = new DatabaseSync(fixture.dbPath);
      const receipt = db2
        .prepare(
          "SELECT detail_code FROM workboard_atomic_create_receipts ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { detail_code: string };
      db2.close();
      expect(receipt.detail_code).toBe("legacy-metadata-malformed");
      // Remove the malformed row; create the canonical card; then add a legacy
      // advertiser: an indexed/legacy mismatch is stored-record invalidity.
      const db3 = new DatabaseSync(fixture.dbPath);
      db3
        .prepare("DELETE FROM workboard_cards WHERE id = '55555555-5555-4555-8555-555555555555'")
        .run();
      db3.close();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(created.reason_code).toBe("workboard_card_created");
      await fixture.store.create({ title: "late legacy advertiser", idempotencyKey: key });
      const mismatch = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(mismatch.reason_code).toBe("workboard_stored_record_invalid");
      const db4 = new DatabaseSync(fixture.dbPath);
      const mismatchReceipt = db4
        .prepare(
          "SELECT detail_code FROM workboard_atomic_create_receipts WHERE detail_code = 'indexed-legacy-mismatch' LIMIT 1",
        )
        .get() as { detail_code: string };
      db4.close();
      expect(mismatchReceipt.detail_code).toBe("indexed-legacy-mismatch");
    } finally {
      fixture.close();
    }
  });

  it("workboard_unavailable: a store without the SQLite atomic authority refuses with no fallback", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const { key, spec } = makeAtomicSpec();
    expect(store.supportsAtomicCreate()).toBe(false);
    const result = await store.createOrRecoverByCorrelationKey(key, spec);
    expect(result.reason_code).toBe("workboard_unavailable");
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(result.evidence).toBeNull();
    // No fallback: nothing was created through the generic path.
    expect(await store.list()).toHaveLength(0);
    expect(await store.getAtomicCreateReceipt("44444444-4444-4444-8444-444444444444")).toEqual({
      schema_version: 1,
      receipt: null,
    });
  });

  it("created cards are canonical, held, and generic surfaces see them on the right board", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(created.card).toMatchObject({
        board_id: "test-board",
        title: spec.title,
        status: "backlog",
        priority: "normal",
        labels: ["automation", "hold", "operator-merge-only"],
        notes: spec.notes,
        agent_id: null,
        claim: null,
        execution: null,
        started_at: null,
        completed_at: null,
        archived_at: null,
      });
      expect(created.card?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created.evidence?.ref).toMatch(
        /^workboard:atomic-create-receipt\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const generic = await fixture.store.get(created.card?.id as string);
      expect(generic?.status).toBe("backlog");
      expect(generic?.metadata?.automation?.boardId).toBe("test-board");
      expect(generic?.metadata?.automation?.idempotencyKey).toBeUndefined();
      const listed = await fixture.store.list({ boardId: "test-board" });
      expect(listed.map((card) => card.id)).toContain(created.card?.id);
    } finally {
      fixture.close();
    }
  });
});

describe("AUT-WB-ATOMIC A25 persisted unknown-field proof", () => {
  const cases: Array<{
    label: string;
    addUnknownField: (spec: Record<string, any>) => void;
  }> = [
    {
      label: "root governance object",
      addUnknownField: (spec) => {
        spec.unknown_root_governance = true;
      },
    },
    {
      label: "automation governance object",
      addUnknownField: (spec) => {
        spec.automation.unknown_automation_governance = true;
      },
    },
    {
      label: "board authority object",
      addUnknownField: (spec) => {
        spec.board.unknown_board_governance = true;
      },
    },
    {
      label: "execution_control authority object",
      addUnknownField: (spec) => {
        spec.execution_control.unknown_execution_governance = true;
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.label}: returns exact stored-invalid evidence and preserves corrupt bytes plus every child surface`, async () => {
      const fixture = openAtomicFixture();
      try {
        const { key, spec } = makeAtomicSpec();
        const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        expect(created.reason_code).toBe("workboard_card_created");
        const cardId = created.card?.id as string;
        const requestedFingerprint = created.stored_fingerprint as string;
        corruptCorrelatedRow(fixture.dbPath, (db) => {
          const row = db
            .prepare("SELECT governance_spec_json FROM workboard_cards WHERE id = ?")
            .get(cardId) as { governance_spec_json: string };
          const persistedSpec = JSON.parse(row.governance_spec_json) as Record<string, any>;
          testCase.addUnknownField(persistedSpec);
          db.prepare("UPDATE workboard_cards SET governance_spec_json = ? WHERE id = ?").run(
            JSON.stringify(persistedSpec),
            cardId,
          );
        });
        const corruptRowBefore = new DatabaseSync(fixture.dbPath);
        const persistedBefore = corruptRowBefore
          .prepare(
            "SELECT governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
          )
          .get(cardId) as {
          governance_spec_json: string;
          governance_fingerprint: string;
        };
        corruptRowBefore.close();
        expect(persistedBefore.governance_fingerprint).toBe(requestedFingerprint);
        const invariantBefore = rawDigest(fixture.dbPath, cardId);
        const receiptsBefore = receiptCount(fixture.dbPath, key);
        const effectSpies = poisonProhibitedAtomicEffects(fixture.store);
        const fallbackSpies = poisonGenericStoreFallbacks(fixture.stores.cards);

        const result = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        expect(result).toEqual({
          schema_version: 1,
          ok: false,
          outcome: "refused",
          reason_code: "workboard_stored_record_invalid",
          retryable: false,
          correlation_key: key,
          card: null,
          stored_spec: null,
          stored_fingerprint: null,
          evidence: {
            kind: "workboard_atomic_receipt",
            ref: expect.stringMatching(
              /^workboard:atomic-create-receipt\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            ),
          },
        });
        const receiptId = result.evidence?.ref.split("/").pop() as string;
        const lookup = await fixture.store.getAtomicCreateReceipt(receiptId);
        expect(lookup.schema_version).toBe(1);
        expect(Object.keys(lookup.receipt ?? {}).toSorted()).toEqual([
          "card_id",
          "correlation_key",
          "created_at",
          "detail_code",
          "id",
          "outcome",
          "reason_code",
          "request_fingerprint",
          "schema_version",
          "stored_fingerprint",
        ]);
        expect(lookup.receipt).toEqual({
          schema_version: 1,
          id: receiptId,
          correlation_key: key,
          card_id: cardId,
          request_fingerprint: requestedFingerprint,
          stored_fingerprint: requestedFingerprint,
          outcome: "refused",
          reason_code: "workboard_stored_record_invalid",
          detail_code: "governance-spec-invalid",
          created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        });
        expect(lookup.receipt).not.toHaveProperty("request_id");
        expect(lookup.receipt).not.toHaveProperty("retryable");
        expect(rawDigest(fixture.dbPath, cardId)).toBe(invariantBefore);
        expect(receiptCount(fixture.dbPath, key)).toBe(receiptsBefore + 1);
        const corruptRowAfter = new DatabaseSync(fixture.dbPath);
        const persistedAfter = corruptRowAfter
          .prepare(
            "SELECT governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
          )
          .get(cardId) as {
          governance_spec_json: string;
          governance_fingerprint: string;
        };
        corruptRowAfter.close();
        expect(persistedAfter).toEqual(persistedBefore);
        for (const spy of [...effectSpies, ...fallbackSpies]) {
          expect(spy).not.toHaveBeenCalled();
          spy.mockRestore();
        }
      } finally {
        vi.restoreAllMocks();
        fixture.close();
      }
    });
  }
});

describe("AUT-WB-ATOMIC no execution surface (A37)", () => {
  it("static: the atomic modules never import dispatcher or subagent surfaces", () => {
    const here = path.dirname(new URL(import.meta.url).pathname);
    for (const file of ["store.ts", "sqlite-store.ts"]) {
      const source = fs.readFileSync(path.join(here, file), "utf8");
      expect(source.includes("dispatcher")).toBe(false);
      expect(source.includes("subagent")).toBe(false);
      expect(source.includes("runtime.subagent")).toBe(false);
    }
  });

  it("dynamic: throwing spies on every execution-adjacent method stay uncalled", async () => {
    const fixture = openAtomicFixture();
    const executionSurfaces = [
      "claim",
      "promote",
      "reclaim",
      "reassign",
      "complete",
      "block",
      "unblock",
      "dispatch",
      "move",
      "create",
      "update",
      "bulkUpdate",
      "heartbeat",
      "releaseClaim",
    ] as const;
    const spies = executionSurfaces.map((method) =>
      vi
        .spyOn(fixture.store as unknown as Record<string, (...args: never[]) => unknown>, method)
        .mockImplementation(() => {
          throw new Error(`execution surface reached: ${method}`);
        }),
    );
    try {
      const { key, spec } = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(created.reason_code).toBe("workboard_card_created");
      const recovered = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(recovered.reason_code).toBe("workboard_card_recovered");
      const conflictSpec = makeAtomicSpec("aut-test.daily-brief", "2026-08-03T12:00:00.000Z", 1, {
        automation: { skill_version: "2.0.0" },
      });
      const conflict = await fixture.store.createOrRecoverByCorrelationKey(key, conflictSpec.spec);
      expect(conflict.reason_code).toBe("workboard_card_conflict");
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
      fixture.close();
    }
  });

  it("buildAtomicEnvelope emits only frozen ok/outcome/retryable combinations", () => {
    const table: Array<[string, boolean, string, boolean]> = [
      ["workboard_card_created", true, "created", false],
      ["workboard_card_recovered", true, "recovered", false],
      ["workboard_card_conflict", false, "refused", false],
      ["workboard_create_request_invalid", false, "refused", false],
      ["workboard_stored_record_invalid", false, "refused", false],
      ["workboard_card_state_incompatible", false, "refused", false],
      ["workboard_unavailable", false, "failed", true],
      ["workboard_storage_failure", false, "failed", true],
      ["workboard_result_uncertain", false, "uncertain", true],
      ["workboard_atomic_migration_required", false, "refused", false],
      ["workboard_incompatible_legacy_card", false, "refused", false],
      ["workboard_result_invalid", false, "failed", true],
    ];
    for (const [code, ok, outcome, retryable] of table) {
      const envelope = buildAtomicEnvelope(code as never, null);
      expect(envelope.ok).toBe(ok);
      expect(envelope.outcome).toBe(outcome);
      expect(envelope.retryable).toBe(retryable);
      expect(Object.keys(envelope).toSorted()).toEqual([
        "card",
        "correlation_key",
        "evidence",
        "ok",
        "outcome",
        "reason_code",
        "retryable",
        "schema_version",
        "stored_fingerprint",
        "stored_spec",
      ]);
    }
  });
});

describe("AUT-WB-ATOMIC canonical stored bytes (Round-1 defect 4)", () => {
  // Rewrites the stored governance_spec_json to semantically equal but
  // non-canonical bytes while leaving the (still fingerprint-consistent, since the
  // fingerprint is computed over canonical bytes) stored fingerprint untouched.
  const variants: Array<{ label: string; rewrite: (canonical: string) => string }> = [
    {
      label: "pretty-printed JSON",
      rewrite: (canonical) => JSON.stringify(JSON.parse(canonical), null, 2),
    },
    {
      label: "reordered keys",
      rewrite: (canonical) => {
        const reversedCanonical = (value: unknown): string => {
          if (Array.isArray(value)) {
            return `[${value.map((entry) => reversedCanonical(entry)).join(",")}]`;
          }
          if (value !== null && typeof value === "object") {
            return `{${Object.keys(value as Record<string, unknown>)
              .toSorted()
              .toReversed()
              .map(
                (key) =>
                  `${JSON.stringify(key)}:${reversedCanonical((value as Record<string, unknown>)[key])}`,
              )
              .join(",")}}`;
          }
          return JSON.stringify(value);
        };
        return reversedCanonical(JSON.parse(canonical));
      },
    },
    {
      label: "insignificant whitespace",
      rewrite: (canonical) => `${canonical} `,
    },
  ];

  for (const variant of variants) {
    it(`${variant.label} with an unchanged stored fingerprint is stored-record invalid, not recovered`, async () => {
      const fixture = openAtomicFixture();
      try {
        const { key, spec } = makeAtomicSpec();
        const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        expect(created.reason_code).toBe("workboard_card_created");
        const cardId = created.card?.id as string;
        corruptCorrelatedRow(fixture.dbPath, (db) => {
          const row = db
            .prepare(
              "SELECT governance_spec_json, governance_fingerprint FROM workboard_cards WHERE id = ?",
            )
            .get(cardId) as { governance_spec_json: string; governance_fingerprint: string };
          const rewritten = variant.rewrite(row.governance_spec_json);
          expect(rewritten).not.toBe(row.governance_spec_json);
          expect(JSON.parse(rewritten)).toEqual(JSON.parse(row.governance_spec_json));
          db.prepare("UPDATE workboard_cards SET governance_spec_json = ? WHERE id = ?").run(
            rewritten,
            cardId,
          );
        });
        const fingerprintAfter = new DatabaseSync(fixture.dbPath)
          .prepare("SELECT governance_fingerprint AS fp FROM workboard_cards WHERE id = ?")
          .get(cardId) as { fp: string };
        expect(fingerprintAfter.fp).toBe(created.stored_fingerprint);
        const before = rawDigest(fixture.dbPath, cardId);
        const result = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
        expect(result.reason_code).toBe("workboard_stored_record_invalid");
        expect(result.ok).toBe(false);
        expect(result.card).toBeNull();
        expect(result.stored_spec).toBeNull();
        expect(result.evidence?.kind).toBe("workboard_atomic_receipt");
        // Not normalized, rewritten, or recovered: bytes and full digest unchanged.
        expect(rawDigest(fixture.dbPath, cardId)).toBe(before);
        const db = new DatabaseSync(fixture.dbPath);
        try {
          const receipt = db
            .prepare(
              "SELECT detail_code FROM workboard_atomic_create_receipts WHERE reason_code = 'workboard_stored_record_invalid' ORDER BY created_at DESC LIMIT 1",
            )
            .get() as { detail_code: string };
          expect(receipt.detail_code).toBe("governance-spec-noncanonical");
        } finally {
          db.close();
        }
      } finally {
        fixture.close();
      }
    });
  }

  it("canonical stored bytes control: the untouched card still recovers", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      const created = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      const recovered = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(recovered.reason_code).toBe("workboard_card_recovered");
      expect(recovered.card?.id).toBe(created.card?.id);
    } finally {
      fixture.close();
    }
  });
});

describe("AUT-WB-ATOMIC closed receipt lookup validation (Round-1 defect 5)", () => {
  type ReceiptRowFixture = {
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
  const VALID_ROW: ReceiptRowFixture = {
    id: "99999999-9999-4999-8999-999999999999",
    correlationKey: FROZEN_KEY,
    cardId: "77777777-7777-4777-8777-777777777777",
    requestFingerprint: FROZEN_FINGERPRINT,
    storedFingerprint: FROZEN_FINGERPRINT,
    outcome: "created",
    reasonCode: "workboard_card_created",
    detailCode: null,
    createdAt: 5,
  };

  function storeWithReceiptRow(row: typeof VALID_ROW) {
    // A minimal atomic-capable stub whose persisted receipt row is adversarial.
    // This unit-tests the closed store-layer validation independently of the SQLite
    // CHECK constraints (which are proven separately at the DDL boundary).
    const capability = {
      atomicCreateOrRecover: () => ({ kind: "uncertain" as const }),
      getAtomicCreateReceipt: () => ({ ...row }),
      isCorrelatedCard: () => false,
      verifyAtomicMigrationComplete: () => true,
    };
    const memory = createMemoryStore();
    return new WorkboardStore(Object.assign(memory, capability));
  }

  it("emits a valid persisted receipt as the closed envelope (control)", async () => {
    const store = storeWithReceiptRow(VALID_ROW);
    const lookup = await store.getAtomicCreateReceipt(VALID_ROW.id);
    expect(lookup.receipt).toMatchObject({
      schema_version: 1,
      id: VALID_ROW.id,
      correlation_key: FROZEN_KEY,
      outcome: "created",
      reason_code: "workboard_card_created",
    });
  });

  it("rejects malformed persisted receipts instead of casting them", async () => {
    const malformedRows: Array<Partial<typeof VALID_ROW>> = [
      { correlationKey: FROZEN_KEY.toUpperCase() },
      { correlationKey: "occ_v2_7a80f585e84b83e031d3eb8823faaee0" },
      { requestFingerprint: `sha256:${"Z".repeat(64)}` },
      { storedFingerprint: "sha1:abc" },
      { cardId: null },
      { cardId: "not-a-uuid" },
      { detailCode: "Free form prose!" },
      { detailCode: "not-in-the-closed-set" },
      { outcome: "refused" },
      { outcome: "created", reasonCode: "workboard_card_recovered" },
      { reasonCode: "workboard_unavailable", outcome: "failed" },
      { createdAt: 0 },
      { createdAt: 1.5 },
    ];
    for (const overrides of malformedRows) {
      const store = storeWithReceiptRow({ ...VALID_ROW, ...overrides });
      await expect(
        store.getAtomicCreateReceipt(VALID_ROW.id),
        JSON.stringify(overrides),
      ).rejects.toThrow(/receipt failed closed validation/);
    }
    // Nullable-combination rules are reason-scoped: a legacy refusal must not carry
    // a stored fingerprint, and a state refusal must carry a detail code.
    await expect(
      storeWithReceiptRow({
        ...VALID_ROW,
        outcome: "refused",
        reasonCode: "workboard_incompatible_legacy_card",
        cardId: null,
        storedFingerprint: FROZEN_FINGERPRINT,
        detailCode: null,
      }).getAtomicCreateReceipt(VALID_ROW.id),
    ).rejects.toThrow(/receipt failed closed validation/);
    await expect(
      storeWithReceiptRow({
        ...VALID_ROW,
        outcome: "refused",
        reasonCode: "workboard_card_state_incompatible",
        detailCode: null,
      }).getAtomicCreateReceipt(VALID_ROW.id),
    ).rejects.toThrow(/receipt failed closed validation/);
  });
});

describe("AUT-WB-ATOMIC escaped legacy key at the store boundary (Round-1 defect 2)", () => {
  it("detects a JSON-escaped semantically equal legacy key and never creates beside it", async () => {
    const fixture = openAtomicFixture();
    try {
      const { key, spec } = makeAtomicSpec();
      const escapedChar = `\\u00${key.charCodeAt(12).toString(16).padStart(2, "0")}`;
      const escapedPayload = `{"idempotencyKey":"${key.slice(0, 12)}${escapedChar}${key.slice(13)}"}`;
      expect(escapedPayload.includes(key)).toBe(false);
      expect((JSON.parse(escapedPayload) as { idempotencyKey: string }).idempotencyKey).toBe(key);
      const db = new DatabaseSync(fixture.dbPath);
      db.prepare(
        `
          INSERT INTO workboard_cards
            (id, board_id, title, status, priority, position, created_at, updated_at, automation_json)
          VALUES ('66666666-6666-4666-8666-666666666667', 'default', 'escaped legacy', 'backlog', 'normal', 1, 1, 1, ?)
        `,
      ).run(escapedPayload);
      db.close();
      const legacyDigestBefore = rawDigest(fixture.dbPath, "66666666-6666-4666-8666-666666666667");
      const result = await fixture.store.createOrRecoverByCorrelationKey(key, spec);
      expect(result.reason_code).toBe("workboard_incompatible_legacy_card");
      expect(result.card).toBeNull();
      expect(receiptCount(fixture.dbPath, key)).toBe(1);
      // Zero adoption, zero mutation: the legacy advertiser is untouched and no
      // correlated card exists.
      expect(rawDigest(fixture.dbPath, "66666666-6666-4666-8666-666666666667")).toBe(
        legacyDigestBefore,
      );
      const check = new DatabaseSync(fixture.dbPath);
      const adopted = check
        .prepare("SELECT COUNT(*) AS n FROM workboard_cards WHERE correlation_key IS NOT NULL")
        .get() as { n: number | bigint };
      check.close();
      expect(Number(adopted.n)).toBe(0);
    } finally {
      fixture.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OT-GOV-4 — atomic per-card worker-start authority (contract v1).
// Matrix rows are cited as [Rn]. Every refusal asserts ZERO MUTATION (§6.8) by
// byte-comparing the card row, labels, attempts, events, claim, and the
// reservation table before and after the call.
// ─────────────────────────────────────────────────────────────────────────────

describe("OT-GOV-4 start authority (store layer)", () => {
  function openStartStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-start-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    const stores = createWorkboardSqliteStores({ dbPath });
    const store = new WorkboardStore(stores.cards, {
      boards: stores.boards,
      subscriptions: stores.subscriptions,
      attachments: stores.attachments,
    });
    return {
      dir,
      dbPath,
      stores,
      store,
      close() {
        stores.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  const UUID = () => crypto.randomUUID().toLowerCase();

  function startRequest(
    card: { id: string; status: string; updatedAt: number },
    over: Record<string, unknown> = {},
  ) {
    return {
      schema_version: 1,
      card_id: card.id,
      attempt_id: UUID(),
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

  // Full persisted-state snapshot for the zero-mutation assertions.
  function snapshot(dbPath: string, cardId: string): string {
    const db = new DatabaseSync(dbPath);
    const pick = (sql: string) => db.prepare(sql).all(cardId);
    const state = {
      card: db.prepare("SELECT * FROM workboard_cards WHERE id = ?").get(cardId),
      labels: pick("SELECT * FROM workboard_card_labels WHERE card_id = ? ORDER BY ordinal"),
      attempts: pick("SELECT * FROM workboard_card_attempts WHERE card_id = ? ORDER BY ordinal"),
      events: pick("SELECT * FROM workboard_card_events WHERE card_id = ? ORDER BY ordinal"),
      reservations: pick(
        "SELECT * FROM workboard_card_start_reservations WHERE card_id = ? ORDER BY reserved_at",
      ),
      receipts: pick(
        "SELECT * FROM workboard_start_receipts WHERE card_id = ? ORDER BY created_at",
      ),
    };
    db.close();
    return JSON.stringify(state);
  }

  async function expectPureRefusal(
    ctx: ReturnType<typeof openStartStore>,
    cardId: string,
    request: unknown,
    reason: string,
  ) {
    const before = snapshot(ctx.dbPath, cardId);
    const response = await ctx.store.startCardIfEligible(request);
    expect(response.reason_code).toBe(reason);
    expect(response.ok).toBe(false);
    expect(response.outcome).toBe("refused");
    expect(response.retryable).toBe(false);
    expect(response.reservation).toBeNull();
    expect(response.evidence).toBeNull();
    expect(snapshot(ctx.dbPath, cardId)).toBe(before);
    return response;
  }

  it("[R1] a valid request on an eligible card reserves: one reservation, one attempt, claim set, receipt appended", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "eligible", status: "ready" });
      const response = await ctx.store.startCardIfEligible(startRequest(card));
      expect(response.ok).toBe(true);
      expect(response.outcome).toBe("reserved");
      expect(response.reason_code).toBe("workboard_start_reserved");
      expect(response.reservation?.worker_bound).toBe(false);
      expect(response.evidence?.kind).toBe("workboard_start_receipt");
      const after = await ctx.store.get(card.id);
      expect(after?.status).toBe("running");
      expect(after?.metadata?.claim?.ownerId).toBe("veelo-start-authority");
      const attempts = after?.metadata?.attempts ?? [];
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("reserved");
      // The receipt is durable and resolvable through the dedicated lookup.
      const receipt = await ctx.store.getStartReceipt(response.evidence?.ref);
      expect(receipt.receipt?.reason_code).toBe("workboard_start_reserved");
      expect(receipt.receipt?.card_id).toBe(card.id);
    } finally {
      ctx.close();
    }
  });

  it("[R2] replay of the same (card_id, attempt_id) recovers without a second row", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "replay", status: "ready" });
      const request = startRequest(card);
      const first = await ctx.store.startCardIfEligible(request);
      expect(first.reason_code).toBe("workboard_start_reserved");
      const replay = await ctx.store.startCardIfEligible(request);
      expect(replay.reason_code).toBe("workboard_start_recovered");
      expect(replay.outcome).toBe("recovered");
      expect(replay.reservation?.reservation_id).toBe(first.reservation?.reservation_id);
      const db = new DatabaseSync(ctx.dbPath);
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM workboard_card_start_reservations WHERE card_id = ?")
        .get(card.id) as { n: number | bigint };
      const attempts = db
        .prepare("SELECT COUNT(*) AS n FROM workboard_card_attempts WHERE card_id = ?")
        .get(card.id) as { n: number | bigint };
      db.close();
      expect(Number(rows.n)).toBe(1);
      expect(Number(attempts.n)).toBe(1);
    } finally {
      ctx.close();
    }
  });

  it("[R5][R6][R7] operator-protection labels refuse with zero mutation", async () => {
    const ctx = openStartStore();
    try {
      for (const label of ["hold", "operator-merge-only", "operator-controlled"]) {
        const card = await ctx.store.create({
          title: `protected ${label}`,
          status: "ready",
          labels: [label],
        });
        await expectPureRefusal(ctx, card.id, startRequest(card), "workboard_start_card_protected");
      }
    } finally {
      ctx.close();
    }
  });

  it("[R8] a card in review refuses as protected even with matching CAS", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "in review", status: "review" });
      await expectPureRefusal(
        ctx,
        card.id,
        startRequest({ id: card.id, status: "review", updatedAt: card.updatedAt }),
        "workboard_start_card_protected",
      );
    } finally {
      ctx.close();
    }
  });

  it("[R9] omitting a mandatory forbidden label is request_invalid before any reservation read", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "weak labels", status: "ready" });
      await expectPureRefusal(
        ctx,
        card.id,
        startRequest(card, { forbidden_labels: ["hold", "operator-merge-only"] }),
        "workboard_start_request_invalid",
      );
    } finally {
      ctx.close();
    }
  });

  it("[R10][R11] parent dependencies gate all_parents_done and only all_parents_done", async () => {
    const ctx = openStartStore();
    try {
      const parent = await ctx.store.create({ title: "parent", status: "todo" });
      const child = await ctx.store.create({ title: "child", status: "todo" });
      await ctx.store.linkCards(parent.id, child.id);
      const linked = await ctx.store.get(child.id);
      // all_parents_done with an unfinished parent refuses [R10]
      await expectPureRefusal(
        ctx,
        child.id,
        startRequest(
          { id: child.id, status: linked?.status ?? "todo", updatedAt: linked?.updatedAt ?? 0 },
          { required_dependency_state: "all_parents_done" },
        ),
        "workboard_start_dependencies_unsatisfied",
      );
      // "none" with the same unmet parent reserves [R11]
      const fresh = await ctx.store.get(child.id);
      const response = await ctx.store.startCardIfEligible(
        startRequest(
          { id: child.id, status: fresh?.status ?? "todo", updatedAt: fresh?.updatedAt ?? 0 },
          { required_dependency_state: "none" },
        ),
      );
      expect(response.reason_code).toBe("workboard_start_reserved");
    } finally {
      ctx.close();
    }
  });

  it("[R12][R13][R14] CAS mismatches refuse without mutation", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "cas", status: "ready" });
      await expectPureRefusal(
        ctx,
        card.id,
        startRequest(card, { expected_status: "todo" }),
        "workboard_start_state_conflict",
      );
      await expectPureRefusal(
        ctx,
        card.id,
        startRequest(card, { expected_updated_at: card.updatedAt + 1 }),
        "workboard_start_state_conflict",
      );
      // [R14] a non-protection label applied between read and call bumps
      // updated_at, so the stale caller view refuses as state_conflict.
      const stale = { id: card.id, status: card.status, updatedAt: card.updatedAt };
      await ctx.store.update(card.id, { labels: ["routine"] });
      await expectPureRefusal(ctx, card.id, startRequest(stale), "workboard_start_state_conflict");
    } finally {
      ctx.close();
    }
  });

  it("[R15][R16] a live claim refuses; an expired claim does not block", async () => {
    const ctx = openStartStore();
    try {
      const live = await ctx.store.create({ title: "claimed", status: "ready" });
      await ctx.store.claim(live.id, { ownerId: "someone", ttlSeconds: 3600 });
      const claimed = await ctx.store.get(live.id);
      // claim() moved it to running; present CAS-true values so the claim check
      // itself is what refuses.
      await expectPureRefusal(
        ctx,
        live.id,
        startRequest(
          { id: live.id, status: claimed?.status ?? "running", updatedAt: claimed?.updatedAt ?? 0 },
          { expected_assignee: claimed?.agentId ?? null },
        ),
        "workboard_start_already_claimed",
      );

      // Expired claim: write one directly, status ready.
      const expired = await ctx.store.create({ title: "expired claim", status: "ready" });
      const db = new DatabaseSync(ctx.dbPath);
      db.prepare("UPDATE workboard_cards SET claim_json = ? WHERE id = ?").run(
        JSON.stringify({
          ownerId: "ghost",
          token: "t",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: 2,
        }),
        expired.id,
      );
      db.close();
      const row = await ctx.store.get(expired.id);
      const response = await ctx.store.startCardIfEligible(
        startRequest({
          id: expired.id,
          status: row?.status ?? "ready",
          updatedAt: row?.updatedAt ?? 0,
        }),
      );
      expect(response.reason_code).toBe("workboard_start_reserved");
    } finally {
      ctx.close();
    }
  });

  it("[R17] an active execution refuses", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "executing", status: "ready" });
      const db = new DatabaseSync(ctx.dbPath);
      db.prepare(
        "UPDATE workboard_cards SET execution_id = ?, execution_kind = 'subagent', execution_engine = 'codex', execution_mode = 'exec', execution_status = 'running', execution_model = 'test-model', execution_started_at = 1, execution_updated_at = 1 WHERE id = ?",
      ).run(crypto.randomUUID(), card.id);
      db.close();
      const row = await ctx.store.get(card.id);
      await expectPureRefusal(
        ctx,
        card.id,
        startRequest({
          id: card.id,
          status: row?.status ?? "ready",
          updatedAt: row?.updatedAt ?? 0,
        }),
        "workboard_start_active_execution",
      );
    } finally {
      ctx.close();
    }
  });

  it("[R18] an exhausted retry budget refuses", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "budget", status: "ready" });
      const db = new DatabaseSync(ctx.dbPath);
      db.prepare(
        "UPDATE workboard_cards SET automation_json = ?, failure_count = 3 WHERE id = ?",
      ).run(JSON.stringify({ maxRetries: 2 }), card.id);
      db.close();
      const row = await ctx.store.get(card.id);
      await expectPureRefusal(
        ctx,
        card.id,
        startRequest({
          id: card.id,
          status: row?.status ?? "ready",
          updatedAt: row?.updatedAt ?? 0,
        }),
        "workboard_start_retry_budget_exhausted",
      );
    } finally {
      ctx.close();
    }
  });

  it("[R19][R20][R21][R22][R23] unknown card, prefix ids, unknown/missing/malformed fields", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "grammar", status: "ready" });
      // unknown card id (valid UUID, no row) [R19]
      const missing = await ctx.store.startCardIfEligible(
        startRequest({ id: UUID(), status: "ready", updatedAt: 1 }),
      );
      expect(missing.reason_code).toBe("workboard_start_card_not_found");
      // prefix instead of exact id [R20]
      const prefix = await ctx.store.startCardIfEligible(
        startRequest(card, { card_id: card.id.slice(0, 8) }),
      );
      expect(prefix.reason_code).toBe("workboard_start_request_invalid");
      // unknown field [R21]
      const unknown = await ctx.store.startCardIfEligible({ ...startRequest(card), extra: true });
      expect(unknown.reason_code).toBe("workboard_start_request_invalid");
      // missing field [R22]
      const partial = startRequest(card) as Record<string, unknown>;
      delete partial.worker;
      const missingField = await ctx.store.startCardIfEligible(partial);
      expect(missingField.reason_code).toBe("workboard_start_request_invalid");
      // malformed attempt_id (uppercase) [R23]
      const upper = await ctx.store.startCardIfEligible(
        startRequest(card, { attempt_id: UUID().toUpperCase() }),
      );
      expect(upper.reason_code).toBe("workboard_start_request_invalid");
    } finally {
      ctx.close();
    }
  });

  it("[R24] a corrupted stored reservation row refuses stored_record_invalid and is never repaired", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "corrupt", status: "ready" });
      const first = await ctx.store.startCardIfEligible(startRequest(card));
      expect(first.reason_code).toBe("workboard_start_reserved");
      const db = new DatabaseSync(ctx.dbPath);
      // Null out a NOT NULL-adjacent field the mapper requires via direct SQL.
      db.prepare(
        "UPDATE workboard_card_start_reservations SET authority_id = '' WHERE card_id = ?",
      ).run(card.id);
      const corrupted = JSON.stringify(
        db
          .prepare("SELECT * FROM workboard_card_start_reservations WHERE card_id = ?")
          .all(card.id),
      );
      db.close();
      const row = await ctx.store.get(card.id);
      const response = await ctx.store.startCardIfEligible(
        startRequest(
          { id: card.id, status: row?.status ?? "running", updatedAt: row?.updatedAt ?? 0 },
          {
            expected_status: row?.status ?? "running",
          },
        ),
      );
      // The protected/claim ladder may refuse first (card is running+claimed);
      // force the corrupt read by targeting the reservation directly through a
      // release, which must also surface stored_record_invalid.
      const release = await ctx.store.releaseStartReservation({
        schema_version: 1,
        reservation_id: first.reservation?.reservation_id,
        attempt_id: first.reservation?.attempt_id,
        reason: "probe",
      });
      expect([response.reason_code, release.reason_code]).toContain(
        "workboard_start_stored_record_invalid",
      );
      const dbAfter = new DatabaseSync(ctx.dbPath);
      const after = JSON.stringify(
        dbAfter
          .prepare("SELECT * FROM workboard_card_start_reservations WHERE card_id = ?")
          .all(card.id),
      );
      dbAfter.close();
      expect(after).toBe(corrupted);
    } finally {
      ctx.close();
    }
  });

  it("[R31] neutral release clears the claim, stops the attempt, keeps failureCount, frees the card", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "release", status: "ready" });
      const reserved = await ctx.store.startCardIfEligible(startRequest(card));
      const failureBefore = (await ctx.store.get(card.id))?.metadata?.failureCount ?? 0;
      const release = await ctx.store.releaseStartReservation({
        schema_version: 1,
        reservation_id: reserved.reservation?.reservation_id,
        attempt_id: reserved.reservation?.attempt_id,
        reason: "canary-neutral-release",
      });
      expect(release.reason_code).toBe("workboard_start_released");
      expect(release.outcome).toBe("released");
      const after = await ctx.store.get(card.id);
      expect(after?.status).toBe("ready");
      expect(after?.metadata?.claim).toBeUndefined();
      expect(after?.metadata?.failureCount ?? 0).toBe(failureBefore);
      const attempts = after?.metadata?.attempts ?? [];
      expect(attempts[0]?.status).toBe("stopped");
    } finally {
      ctx.close();
    }
  });

  it("[R32][R33] double release is a typed refusal; a released attempt_id is never reused", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "double", status: "ready" });
      const request = startRequest(card);
      const reserved = await ctx.store.startCardIfEligible(request);
      const releaseRequest = {
        schema_version: 1,
        reservation_id: reserved.reservation?.reservation_id,
        attempt_id: reserved.reservation?.attempt_id,
        reason: "first",
      };
      const first = await ctx.store.releaseStartReservation(releaseRequest);
      expect(first.reason_code).toBe("workboard_start_released");
      const second = await ctx.store.releaseStartReservation({
        ...releaseRequest,
        reason: "second",
      });
      expect(second.reason_code).toBe("workboard_start_state_conflict");
      expect(second.ok).toBe(false);
      // [R33] reusing the released attempt_id refuses request_invalid.
      const row = await ctx.store.get(card.id);
      const reuse = await ctx.store.startCardIfEligible(
        startRequest(
          { id: card.id, status: row?.status ?? "ready", updatedAt: row?.updatedAt ?? 0 },
          { attempt_id: request.attempt_id, expected_assignee: row?.agentId ?? null },
        ),
      );
      expect(reuse.reason_code).toBe("workboard_start_request_invalid");
      // A NEW attempt_id reserves cleanly after the neutral release.
      const again = await ctx.store.startCardIfEligible(
        startRequest(
          { id: card.id, status: row?.status ?? "ready", updatedAt: row?.updatedAt ?? 0 },
          { expected_assignee: row?.agentId ?? null },
        ),
      );
      expect(again.reason_code).toBe("workboard_start_reserved");
    } finally {
      ctx.close();
    }
  });

  it("[R35][R36] receipts refuse UPDATE and DELETE; reserved cards cannot be physically deleted; generic update leaves reservations untouched", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "triggers", status: "ready" });
      const reserved = await ctx.store.startCardIfEligible(startRequest(card));
      expect(reserved.reason_code).toBe("workboard_start_reserved");
      const db = new DatabaseSync(ctx.dbPath);
      expect(() =>
        db.prepare("UPDATE workboard_start_receipts SET outcome = 'released'").run(),
      ).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM workboard_start_receipts").run()).toThrow(/append-only/);
      expect(() => db.prepare("DELETE FROM workboard_cards WHERE id = ?").run(card.id)).toThrow(
        /unreleased start reservations/,
      );
      const before = JSON.stringify(
        db
          .prepare("SELECT * FROM workboard_card_start_reservations WHERE card_id = ?")
          .all(card.id),
      );
      db.close();
      // A generic metadata/title update cannot touch reservation state.
      await ctx.store.update(card.id, { title: "renamed while reserved" });
      const dbAfter = new DatabaseSync(ctx.dbPath);
      const after = JSON.stringify(
        dbAfter
          .prepare("SELECT * FROM workboard_card_start_reservations WHERE card_id = ?")
          .all(card.id),
      );
      dbAfter.close();
      expect(after).toBe(before);
    } finally {
      ctx.close();
    }
  });

  it("[R37] a direct claim racing the reservation has exactly one winner", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "race claim", status: "ready" });
      const reserved = await ctx.store.startCardIfEligible(startRequest(card));
      expect(reserved.reason_code).toBe("workboard_start_reserved");
      await expect(ctx.store.claim(card.id, { ownerId: "poacher" })).rejects.toThrow(
        /already claimed/,
      );
    } finally {
      ctx.close();
    }
  });

  it("[R25] with schema-4 absent the method refuses migration_required and claim/complete work unchanged", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "legacy surface", status: "ready" });
      const db = new DatabaseSync(ctx.dbPath);
      db.exec("DROP TRIGGER workboard_cards_reserved_no_delete");
      db.exec("DROP TABLE workboard_start_receipts");
      db.exec("DROP TABLE workboard_card_start_reservations");
      db.prepare(
        "DELETE FROM workboard_schema_migrations WHERE id IN ('schema-4','schema-4-ot-gov-4')",
      ).run();
      db.close();
      const response = await ctx.store.startCardIfEligible(startRequest(card));
      expect(response.reason_code).toBe("workboard_start_migration_required");
      // Pre-existing surfaces continue to work (§6.15).
      const claimed = await ctx.store.claim(card.id, { ownerId: "legacy" });
      expect(claimed.card.status).toBe("running");
      const completed = await ctx.store.complete(card.id, {
        ownerId: "legacy",
        token: claimed.token,
        summary: "legacy path unaffected by missing schema-4",
      });
      expect(completed.status).toBe("done");
    } finally {
      ctx.close();
    }
  });

  it("[R26] a partially applied schema-4 refuses migration_required and is never repaired in place", async () => {
    const ctx = openStartStore();
    try {
      const card = await ctx.store.create({ title: "partial schema", status: "ready" });
      const db = new DatabaseSync(ctx.dbPath);
      db.exec("DROP TABLE workboard_start_receipts");
      db.prepare(
        "DELETE FROM workboard_schema_migrations WHERE id IN ('schema-4','schema-4-ot-gov-4')",
      ).run();
      const master = JSON.stringify(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE 'workboard_start%' OR name LIKE 'workboard_card_start%' ORDER BY name",
          )
          .all(),
      );
      db.close();
      const response = await ctx.store.startCardIfEligible(startRequest(card));
      expect(response.reason_code).toBe("workboard_start_migration_required");
      const dbAfter = new DatabaseSync(ctx.dbPath);
      const masterAfter = JSON.stringify(
        dbAfter
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE 'workboard_start%' OR name LIKE 'workboard_card_start%' ORDER BY name",
          )
          .all(),
      );
      dbAfter.close();
      expect(masterAfter).toBe(master);
    } finally {
      ctx.close();
    }
  });
});
