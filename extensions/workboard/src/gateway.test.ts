// Workboard tests cover gateway plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
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

describe("workboard gateway methods", () => {
  it("registers CRUD methods with read/write scopes", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    expect([...methods.keys()]).toEqual([
      "workboard.cards.list",
      "workboard.cards.create",
      "workboard.cards.update",
      "workboard.cards.move",
      "workboard.cards.delete",
      "workboard.cards.comment",
      "workboard.cards.link",
      "workboard.cards.linkDependency",
      "workboard.cards.proof",
      "workboard.cards.artifact",
      "workboard.cards.claim",
      "workboard.cards.heartbeat",
      "workboard.cards.release",
      "workboard.cards.promote",
      "workboard.cards.reassign",
      "workboard.cards.reclaim",
      "workboard.cards.complete",
      "workboard.cards.block",
      "workboard.cards.unblock",
      "workboard.cards.bulk",
      "workboard.cards.diagnostics",
      "workboard.cards.diagnostics.refresh",
      "workboard.cards.dispatch",
      "workboard.boards.list",
      "workboard.boards.upsert",
      "workboard.boards.archive",
      "workboard.boards.delete",
      "workboard.cards.stats",
      "workboard.cards.runs",
      "workboard.cards.specify",
      "workboard.cards.decompose",
      "workboard.notifications.subscribe",
      "workboard.notifications.list",
      "workboard.notifications.delete",
      "workboard.notifications.events",
      "workboard.notifications.advance",
      "workboard.cards.attachments.list",
      "workboard.cards.attachments.get",
      "workboard.cards.attachments.add",
      "workboard.cards.attachments.delete",
      "workboard.cards.workerLog",
      "workboard.cards.protocolViolation",
      "workboard.cards.archive",
      "workboard.cards.export",
    ]);
    expect(methods.get("workboard.cards.list")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.diagnostics.refresh")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.cards.export")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.create")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.cards.runs")?.opts).toEqual({ scope: "operator.read" });
    expect(methods.get("workboard.cards.attachments.get")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.cards.attachments.add")?.opts).toEqual({
      scope: "operator.write",
    });
    expect(methods.get("workboard.boards.upsert")?.opts).toEqual({ scope: "operator.write" });
    expect(methods.get("workboard.notifications.list")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.events")?.opts).toEqual({
      scope: "operator.read",
    });
    expect(methods.get("workboard.notifications.advance")?.opts).toEqual({
      scope: "operator.write",
    });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const listHandler = methods.get("workboard.cards.list")?.handler;
    const createRespond = vi.fn();
    await createHandler?.({
      params: { title: "Investigate queue drift", priority: "urgent" },
      respond: createRespond,
    } as never);
    expect(createRespond.mock.calls[0]?.[0]).toBe(true);

    const listRespond = vi.fn();
    await listHandler?.({ params: {}, respond: listRespond } as never);
    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ title: "Investigate queue drift" })],
    });

    const eventsRespond = vi.fn();
    await methods.get("workboard.notifications.events")?.handler({
      params: { advance: true },
      respond: eventsRespond,
    } as never);
    expect(eventsRespond.mock.calls[0]?.[0]).toBe(false);
    expect(eventsRespond.mock.calls[0]?.[2]?.message).toContain("workboard.notifications.advance");
  });

  it("stores metadata updates through dedicated card methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Carry metadata" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const commentRespond = vi.fn();
    await methods.get("workboard.cards.comment")?.handler({
      params: { id: cardId, body: "Waiting on CI" },
      respond: commentRespond,
    } as never);

    expect(commentRespond.mock.calls[0]?.[0]).toBe(true);
    expect(commentRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        metadata: {
          comments: [expect.objectContaining({ body: "Waiting on CI" })],
        },
        events: expect.arrayContaining([expect.objectContaining({ kind: "comment_added" })]),
      },
    });
  });

  it("validates labels from comma-separated gateway input", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createHandler = methods.get("workboard.cards.create")?.handler;
    const respond = vi.fn();
    await createHandler?.({
      params: { title: "Check labels", labels: `valid, ${"x".repeat(41)}` },
      respond,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: "labels must be 40 characters or fewer.",
    });
  });

  it("dispatches workboard cards when gateway params are omitted", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
        subagent: { run },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Ready worker",
      status: "ready",
      priority: "urgent",
    });

    registerWorkboardGatewayMethods({ api, store });

    const respond = vi.fn();
    await methods.get("workboard.cards.dispatch")?.handler({ respond } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      started: [expect.objectContaining({ cardId: card.id, runId: "run-card" })],
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
  });

  it("requires admin scope for managed-worktree dispatch", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const run = vi.fn().mockResolvedValue({ runId: "run-card" });
    const createWorktree = vi.fn().mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    const api = {
      runtime: {
        subagent: { run },
        worktrees: {
          create: createWorktree,
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(createMemoryStore());
    const denied = await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });
    registerWorkboardGatewayMethods({ api, store });
    const handler = methods.get("workboard.cards.dispatch")?.handler;

    const deniedRespond = vi.fn();
    await handler?.({
      client: { connect: { scopes: ["operator.write"] } },
      respond: deniedRespond,
    } as never);

    expect(createWorktree).not.toHaveBeenCalled();
    expect(deniedRespond.mock.calls[0]?.[1]).toMatchObject({
      startFailures: [
        expect.objectContaining({
          cardId: denied.id,
          error: "managed worktree dispatch requires operator.admin",
        }),
      ],
    });
    await expect(store.get(denied.id)).resolves.toMatchObject({ status: "ready" });
    await store.update(denied.id, { status: "blocked" });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-allowed" },
    });
    await handler?.({
      client: { connect: { scopes: ["operator.admin"] } },
      respond: vi.fn(),
    } as never);

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: "/repo-allowed", ownerId: allowed.id }),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("claims, heartbeats, and bulk-updates cards through gateway methods", async () => {
    type RegisteredMethod = {
      handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
      opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
    };
    const methods = new Map<string, RegisteredMethod>();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => createMemoryStore()),
        },
      },
      registerGatewayMethod: vi.fn(
        (method: string, handler: RegisteredMethod["handler"], opts: RegisteredMethod["opts"]) => {
          methods.set(method, { handler, opts });
        },
      ),
    } as unknown as OpenClawPluginApi;

    registerWorkboardGatewayMethods({ api, store: new WorkboardStore(createMemoryStore()) });

    const createRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Claim me" },
      respond: createRespond,
    } as never);
    const cardId = createRespond.mock.calls[0]?.[1]?.card.id;

    const claimRespond = vi.fn();
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: cardId, ownerId: "main" },
      respond: claimRespond,
    } as never);
    expect(claimRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "running", metadata: { claim: { ownerId: "main" } } },
      token: expect.any(String),
    });

    const heartbeatRespond = vi.fn();
    await methods.get("workboard.cards.heartbeat")?.handler({
      params: { id: cardId, ownerId: "main", note: "alive" },
      respond: heartbeatRespond,
    } as never);
    expect(heartbeatRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { metadata: { comments: [expect.objectContaining({ body: "alive" })] } },
    });

    const bulkRespond = vi.fn();
    await methods.get("workboard.cards.bulk")?.handler({
      params: { ids: [cardId], patch: { priority: "urgent" } },
      respond: bulkRespond,
    } as never);
    expect(bulkRespond.mock.calls[0]?.[1]).toMatchObject({
      cards: [expect.objectContaining({ priority: "urgent" })],
    });

    const completeRespond = vi.fn();
    await methods.get("workboard.cards.complete")?.handler({
      params: { id: cardId, summary: "Operator closed it." },
      respond: completeRespond,
    } as never);
    expect(completeRespond.mock.calls[0]?.[1]).toMatchObject({
      card: {
        status: "done",
        metadata: {
          comments: expect.arrayContaining([
            expect.objectContaining({ body: "Operator closed it." }),
          ]),
        },
      },
    });

    const blockedCreateRespond = vi.fn();
    await methods.get("workboard.cards.create")?.handler({
      params: { title: "Block me" },
      respond: blockedCreateRespond,
    } as never);
    const blockedCardId = blockedCreateRespond.mock.calls[0]?.[1]?.card.id;
    await methods.get("workboard.cards.claim")?.handler({
      params: { id: blockedCardId, ownerId: "main" },
      respond: vi.fn(),
    } as never);
    const blockRespond = vi.fn();
    await methods.get("workboard.cards.block")?.handler({
      params: { id: blockedCardId, reason: "Operator blocked it." },
      respond: blockRespond,
    } as never);
    expect(blockRespond.mock.calls[0]?.[1]).toMatchObject({
      card: { status: "blocked" },
    });
  });
});

// ---- AUT-WB-ATOMIC gateway boundary (contract aut-wb-atomic/1 §2.1, §8.1) ----------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { atomicCardNotes, atomicCardTitle, deriveAtomicOccurrenceKey } from "./store.js";
import type { AtomicCreateResponseV1, CanonicalAutomationCardSpecV1 } from "./types.js";

function makeAtomicSpec(
  automationId = "aut-test.daily-brief",
  scheduledAt = "2026-08-03T12:00:00.000Z",
): { key: string; spec: CanonicalAutomationCardSpecV1 } {
  const automation = {
    occurrence_key: deriveAtomicOccurrenceKey(automationId, 1, scheduledAt),
    automation_id: automationId,
    schedule_revision: 1,
    scheduled_at: scheduledAt,
    skill_name: "workboard-worker",
    skill_version: "1.2.0",
    risk_class: "read-only" as const,
    approval_policy: "operator-required" as const,
    output_contract_ref: "contracts/output/daily-brief@1",
    verification_contract_ref: "contracts/verify/daily-brief@1",
  };
  return {
    key: automation.occurrence_key,
    spec: {
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
    } as CanonicalAutomationCardSpecV1,
  };
}

type RegisteredGatewayMethod = {
  handler: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  opts: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2];
};

function captureApi(): { api: OpenClawPluginApi; methods: Map<string, RegisteredGatewayMethod> } {
  const methods = new Map<string, RegisteredGatewayMethod>();
  const api = {
    registerGatewayMethod: vi.fn(
      (
        method: string,
        handler: RegisteredGatewayMethod["handler"],
        opts: RegisteredGatewayMethod["opts"],
      ) => {
        methods.set(method, { handler, opts });
      },
    ),
  } as unknown as OpenClawPluginApi;
  return { api, methods };
}

async function invoke(
  methods: Map<string, RegisteredGatewayMethod>,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload: unknown; error: unknown }> {
  const respond = vi.fn();
  await methods.get(method)?.handler({ params, respond } as never);
  const call = respond.mock.calls[0];
  return { ok: call?.[0] as boolean, payload: call?.[1], error: call?.[2] };
}

describe("workboard atomic gateway methods", () => {
  it("registers the two atomic methods only for a migration-verified sqlite store", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-gw-"));
    try {
      const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
      const sqliteBacked = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const withSqlite = captureApi();
      registerWorkboardGatewayMethods({ api: withSqlite.api, store: sqliteBacked });
      expect(withSqlite.methods.has("workboard.cards.createOrRecoverByCorrelationKey")).toBe(true);
      expect(withSqlite.methods.has("workboard.atomicCreateReceipts.get")).toBe(true);
      expect(
        withSqlite.methods.get("workboard.cards.createOrRecoverByCorrelationKey")?.opts,
      ).toEqual({ scope: "operator.write" });
      expect(withSqlite.methods.get("workboard.atomicCreateReceipts.get")?.opts).toEqual({
        scope: "operator.read",
      });
      stores.close();
      // A store without the SQLite atomic authority exposes no atomic surface at all.
      const withMemory = captureApi();
      registerWorkboardGatewayMethods({
        api: withMemory.api,
        store: new WorkboardStore(createMemoryStore()),
      });
      expect(withMemory.methods.has("workboard.cards.createOrRecoverByCorrelationKey")).toBe(false);
      expect(withMemory.methods.has("workboard.atomicCreateReceipts.get")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips created/recovered/conflict envelopes and resolves receipts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-gw-"));
    try {
      const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const { api, methods } = captureApi();
      registerWorkboardGatewayMethods({ api, store });
      const { key, spec } = makeAtomicSpec();

      const created = await invoke(methods, "workboard.cards.createOrRecoverByCorrelationKey", {
        correlationKey: key,
        cardSpec: spec,
      });
      expect(created.ok).toBe(true);
      const createdEnvelope = created.payload as AtomicCreateResponseV1;
      expect(createdEnvelope.reason_code).toBe("workboard_card_created");
      expect(createdEnvelope.schema_version).toBe(1);
      expect(createdEnvelope.correlation_key).toBe(key);
      expect(createdEnvelope.card?.status).toBe("backlog");
      expect(createdEnvelope.evidence?.kind).toBe("workboard_atomic_receipt");

      const recovered = await invoke(methods, "workboard.cards.createOrRecoverByCorrelationKey", {
        correlationKey: key,
        cardSpec: spec,
      });
      const recoveredEnvelope = recovered.payload as AtomicCreateResponseV1;
      expect(recoveredEnvelope.reason_code).toBe("workboard_card_recovered");
      expect(recoveredEnvelope.card?.id).toBe(createdEnvelope.card?.id);

      const receiptId = createdEnvelope.evidence?.ref.split("/").pop() as string;
      const lookup = await invoke(methods, "workboard.atomicCreateReceipts.get", { id: receiptId });
      expect(lookup.ok).toBe(true);
      expect(lookup.payload).toMatchObject({
        schema_version: 1,
        receipt: {
          id: receiptId,
          correlation_key: key,
          reason_code: "workboard_card_created",
        },
      });
      const missing = await invoke(methods, "workboard.atomicCreateReceipts.get", {
        id: "99999999-9999-4999-8999-999999999999",
      });
      expect(missing.payload).toEqual({ schema_version: 1, receipt: null });
      stores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown or missing request fields as closed typed outcomes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-gw-"));
    try {
      const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const { api, methods } = captureApi();
      registerWorkboardGatewayMethods({ api, store });
      const { key, spec } = makeAtomicSpec();

      for (const params of [
        {},
        { correlationKey: key },
        { cardSpec: spec },
        { correlationKey: key, cardSpec: spec, extra: 1 },
        { correlationKey: key, spec },
      ]) {
        const result = await invoke(
          methods,
          "workboard.cards.createOrRecoverByCorrelationKey",
          params as Record<string, unknown>,
        );
        expect(result.ok).toBe(true);
        const envelope = result.payload as AtomicCreateResponseV1;
        expect(envelope.reason_code).toBe("workboard_create_request_invalid");
        expect(envelope.ok).toBe(false);
        expect(envelope.outcome).toBe("refused");
        expect(envelope.evidence).toBeNull();
      }
      // The receipts lookup accepts exactly {id}.
      const extra = await invoke(methods, "workboard.atomicCreateReceipts.get", {
        id: "99999999-9999-4999-8999-999999999999",
        verbose: true,
      });
      expect(extra.ok).toBe(false);
      expect((extra.error as { code?: string })?.code).toBe("workboard_error");
      const noId = await invoke(methods, "workboard.atomicCreateReceipts.get", {});
      expect(noId.ok).toBe(false);
      stores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies an escaping store failure as workboard_result_uncertain (transport uncertainty)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-gw-"));
    try {
      const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const { api, methods } = captureApi();
      registerWorkboardGatewayMethods({ api, store });
      const { key, spec } = makeAtomicSpec();
      vi.spyOn(store, "createOrRecoverByCorrelationKey").mockImplementation(() => {
        throw new Error("transport lost after request acceptance");
      });
      const result = await invoke(methods, "workboard.cards.createOrRecoverByCorrelationKey", {
        correlationKey: key,
        cardSpec: spec,
      });
      expect(result.ok).toBe(true);
      const envelope = result.payload as AtomicCreateResponseV1;
      expect(envelope.reason_code).toBe("workboard_result_uncertain");
      expect(envelope.outcome).toBe("uncertain");
      expect(envelope.retryable).toBe(true);
      expect(envelope.correlation_key).toBe(key);
      expect(envelope.evidence).toBeNull();
      stores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A04 server sub-proof: a committed create whose response is lost recovers on same-key retry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-atomic-gw-"));
    try {
      const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
      const store = new WorkboardStore(stores.cards, {
        boards: stores.boards,
        subscriptions: stores.subscriptions,
        attachments: stores.attachments,
      });
      const { api, methods } = captureApi();
      registerWorkboardGatewayMethods({ api, store });
      const { key, spec } = makeAtomicSpec();
      // Commit succeeds server-side; the transport drops the response before the
      // caller sees it (respond throws after the store committed).
      const handler = methods.get("workboard.cards.createOrRecoverByCorrelationKey")?.handler;
      const dropRespond = vi.fn(() => {
        throw new Error("connection reset");
      });
      await expect(
        handler?.({
          params: { correlationKey: key, cardSpec: spec },
          respond: dropRespond,
        } as never),
      ).rejects.toThrow(/connection reset/);
      // Retry through the same key recovers the committed card.
      const retry = await invoke(methods, "workboard.cards.createOrRecoverByCorrelationKey", {
        correlationKey: key,
        cardSpec: spec,
      });
      const envelope = retry.payload as AtomicCreateResponseV1;
      expect(envelope.reason_code).toBe("workboard_card_recovered");
      expect(envelope.card).not.toBeNull();
      // The create receipt from the lost-response call resolves after the retry.
      const receiptId = envelope.evidence?.ref.split("/").pop() as string;
      const lookup = await invoke(methods, "workboard.atomicCreateReceipts.get", { id: receiptId });
      expect((lookup.payload as { receipt: { reason_code: string } }).receipt.reason_code).toBe(
        "workboard_card_recovered",
      );
      stores.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
