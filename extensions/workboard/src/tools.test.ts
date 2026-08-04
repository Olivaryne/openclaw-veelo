// Workboard tests cover tools plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";
import { guardWorkboardToolsForWorkspaceAccess } from "./workspace-access.js";

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

function readPayload(result: unknown): Record<string, unknown> {
  return (result as { details?: Record<string, unknown> }).details ?? {};
}

describe("workboard tools", () => {
  it("inherits the active tool filesystem boundary for workspace metadata", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    const restrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: true },
    } as const;
    const restricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context: restrictedContext }),
        restrictedContext,
      ).map((tool) => [tool.name, tool]),
    );

    await expect(
      restricted.get("workboard_create")?.execute("outside", {
        title: "Outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
    await expect(
      restricted.get("workboard_create")?.execute("inside", {
        title: "Inside",
        workspace: { kind: "worktree", path: "/workspace/repo" },
        workspaceAccess: { unrestricted: true },
      }),
    ).resolves.toBeDefined();

    const unrestrictedContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
    } as const;
    const unrestricted = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context: unrestrictedContext }),
        unrestrictedContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      unrestricted.get("workboard_create")?.execute("unrestricted", {
        title: "Unrestricted",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).resolves.toBeDefined();

    expect((await store.list()).find((card) => card.title === "Inside")).toMatchObject({
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
        },
      },
    });
    expect((await store.list()).find((card) => card.title === "Unrestricted")).toMatchObject({
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    const sandboxContext = {
      agentId: "main",
      workspaceDir: "/workspace",
      fsPolicy: { workspaceOnly: false },
      sandboxed: true,
    } as const;
    const sandboxed = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context: sandboxContext }),
        sandboxContext,
      ).map((tool) => [tool.name, tool]),
    );
    await expect(
      sandboxed.get("workboard_create")?.execute("sandbox-outside", {
        title: "Sandbox outside",
        workspace: { kind: "worktree", path: "/outside/repo" },
      }),
    ).rejects.toThrow(/outside the caller/);
  });

  it("preserves read-only sandbox authority while allowing manual card movement", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    const context: NonNullable<Parameters<typeof guardWorkboardToolsForWorkspaceAccess>[1]> = {
      agentId: "main",
      sessionKey: "agent:main:subagent:readonly",
      workspaceDir: "/workspace",
      sandboxed: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "ro" } },
          list: [{ id: "main", default: true, workspace: "/workspace" }],
        },
      },
    };
    const tools = new Map(
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, store, context }),
        context,
      ).map((tool) => [tool.name, tool]),
    );

    const created = readPayload(
      await tools.get("workboard_create")?.execute("create-readonly", {
        title: "Read-only card",
      }),
    ).card as { id: string };
    await expect(
      tools.get("workboard_promote")?.execute("move-readonly", { id: created.id, force: true }),
    ).resolves.toBeDefined();
    await expect(store.get(created.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: false },
        },
      },
    });
  });

  it("lists, claims, heartbeats, and reads worker context", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const workboardStore = new WorkboardStore(keyed);
    const tools = createWorkboardTools({
      api,
      store: workboardStore,
      context: { agentId: "main", sessionKey: "session-1" } as never,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const store = keyed;
    await store.register("card-1", {
      version: 1,
      card: {
        id: "card-1",
        title: "Ship coordination",
        status: "todo",
        priority: "normal",
        labels: [],
        agentId: "main",
        position: 1000,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await store.register("archived-1", {
      version: 1,
      card: {
        id: "archived-1",
        title: "Closed work",
        status: "done",
        priority: "normal",
        labels: [],
        position: 2000,
        createdAt: 1,
        updatedAt: 1,
        metadata: { archivedAt: 2 },
      },
    });

    const claimed = readPayload(
      await byName.get("workboard_claim")?.execute("call-1", { id: "card-1" }),
    );
    expect(claimed.card).toMatchObject({
      status: "running",
      metadata: { claim: { ownerId: "main", token: "[redacted]" } },
    });
    const token = (claimed.token as string | undefined) ?? "";

    const heartbeat = readPayload(
      await byName
        .get("workboard_heartbeat")
        ?.execute("call-2", { id: "card-1", token, note: "alive" }),
    );
    expect(heartbeat).toMatchObject({
      metadata: { comments: [expect.objectContaining({ body: "alive" })] },
    });

    const read = readPayload(
      await byName.get("workboard_read")?.execute("call-3", { id: "card-1" }),
    );
    expect(read.workerContext).toContain("Ship coordination");
    expect(read.card).toMatchObject({ metadata: { claim: { token: "[redacted]" } } });

    const released = readPayload(
      await byName
        .get("workboard_release")
        ?.execute("call-4", { id: "card-1", token, status: "review" }),
    );
    expect(released).toMatchObject({ status: "review" });
    expect((released.metadata as { claim?: unknown } | undefined)?.claim).toBeUndefined();

    const list = readPayload(await byName.get("workboard_list")?.execute("call-5", {}));
    expect(list.cards).toEqual([expect.objectContaining({ id: "card-1" })]);
    const archivedList = readPayload(
      await byName.get("workboard_list")?.execute("call-6", { includeArchived: true }),
    );
    expect(archivedList.cards).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "archived-1", archivedAt: 2 })]),
    );
  });

  it("can share one store across tool instances for claim coordination", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Single owner" });

    await mainTools.get("workboard_claim")?.execute("call-1", { id: card.id });

    await expect(
      otherTools.get("workboard_claim")?.execute("call-2", { id: card.id }),
    ).rejects.toThrow(/already claimed/);
  });

  it("requires claim scope before creating or linking dependencies against claimed cards", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const mainTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const otherTools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "other" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const parent = await store.create({ title: "Claimed parent" });
    const claimed = await store.claim(parent.id, { ownerId: "main", token: "parent-token" });

    await expect(
      otherTools.get("workboard_create")?.execute("call-1", {
        title: "Blocked child",
        parents: [parent.id],
      }),
    ).rejects.toThrow(/claimed by main/);
    await expect(
      otherTools.get("workboard_create")?.execute("call-1b", {
        title: "Blocked child",
        parents: parent.id,
      }),
    ).rejects.toThrow(/claimed by main/);
    expect(await store.list()).toHaveLength(1);

    await expect(
      otherTools.get("workboard_create")?.execute("call-2b", {
        title: "Wrong token child",
        parents: [parent.id],
        token: "test-token-placeholder",
      }),
    ).rejects.toThrow(/claimed by main/);
    await otherTools.get("workboard_create")?.execute("call-2", {
      title: "Scoped child",
      parents: [parent.id],
      token: claimed.token,
    });
    const child = await store.create({ title: "Claimed child" });
    await store.claim(child.id, { ownerId: "main", token: "child-token" });
    await expect(
      otherTools.get("workboard_link")?.execute("call-3", {
        parentId: parent.id,
        childId: child.id,
      }),
    ).rejects.toThrow(/claimed by main/);

    const linked = readPayload(
      await otherTools.get("workboard_link")?.execute("call-4", {
        parentId: parent.id,
        childId: (await store.create({ title: "Idle child" })).id,
        token: claimed.token,
      }),
    );
    expect(linked.card).toMatchObject({ status: "todo" });

    await expect(
      mainTools.get("workboard_link")?.execute("call-5", {
        parentId: parent.id,
        childId: child.id,
        token: "child-token",
      }),
    ).rejects.toThrow(/active child/);
  });

  it("creates dependent cards and completes claimed work through tools", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const parentPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-1", {
        title: "Parent",
        status: "running",
      }),
    );
    const parent = parentPayload.card as { id: string };
    const childPayload = readPayload(
      await tools.get("workboard_create")?.execute("call-2", {
        title: "Child",
        parents: [parent.id],
        tenant: "qa",
        skills: ["testing"],
      }),
    );
    const child = childPayload.card as { id: string; status: string };
    expect(child.status).toBe("todo");

    await expect(
      tools.get("workboard_complete")?.execute("call-unclaimed-complete", {
        id: parent.id,
        summary: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_block")?.execute("call-unclaimed-block", {
        id: child.id,
        reason: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);
    await expect(
      tools.get("workboard_protocol_violation")?.execute("call-unclaimed-violation", {
        id: child.id,
        detail: "Too early.",
      }),
    ).rejects.toThrow(/claimed/);

    const claimed = readPayload(
      await tools.get("workboard_claim")?.execute("call-3", { id: parent.id }),
    );
    const token = claimed.token as string;
    const pendingProof = readPayload(
      await tools.get("workboard_proof")?.execute("call-proof", {
        id: parent.id,
        token,
        command: "pnpm test extensions/workboard",
      }),
    );
    expect(pendingProof.proofId).toEqual(expect.any(String));
    const completed = readPayload(
      await tools.get("workboard_complete")?.execute("call-4", {
        id: parent.id,
        token,
        summary: "Done.",
        createdCardIds: [child.id],
        proofId: pendingProof.proofId,
        proof: { status: "passed", command: "pnpm test extensions/workboard" },
      }),
    );
    expect(completed.card).toMatchObject({
      status: "done",
      metadata: { proof: [{ id: pendingProof.proofId, status: "passed" }] },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-5", {}));
    expect(dispatch.promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
  });

  it("redacts claim tokens from dispatch tool results", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: 1,
    });
    await store.update(card.id, {
      metadata: {
        ...card.metadata,
        claim: {
          ownerId: "main",
          token: "secret-token",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const dispatch = readPayload(await tools.get("workboard_dispatch")?.execute("call-1", {}));

    const promoted = dispatch.promoted as Array<{
      metadata?: { claim?: { token?: string } };
    }>;
    expect(promoted).toEqual([expect.objectContaining({ id: card.id })]);
    expect(promoted[0]?.metadata?.claim?.token).toBe("[redacted]");
  });

  it("exposes board lifecycle, decomposition, runs, and notification tools", async () => {
    const keyed = createMemoryStore();
    const api = {
      runtime: {
        state: {
          openKeyedStore: vi.fn(() => keyed),
        },
      },
    } as unknown as OpenClawPluginApi;
    const store = new WorkboardStore(keyed);
    const tools = new Map(
      createWorkboardTools({
        api,
        store,
        context: { agentId: "main" } as never,
      }).map((tool) => [tool.name, tool]),
    );

    const boardPayload = readPayload(
      await tools.get("workboard_board_create")?.execute("call-board", {
        id: "planning",
        name: "Planning",
        orchestration: {
          autoDecompose: true,
          autoDecomposePerDispatch: 2,
          orchestratorProfile: "planner",
        },
      }),
    );
    expect(boardPayload.board).toMatchObject({
      id: "planning",
      name: "Planning",
      orchestration: {
        autoDecompose: true,
        autoDecomposePerDispatch: 2,
        orchestratorProfile: "planner",
      },
    });

    const parent = await store.create({
      title: "Rough",
      status: "triage",
      boardId: "planning",
      idempotencyKey: "planning:rough",
    });
    const specified = readPayload(
      await tools.get("workboard_specify")?.execute("call-specify", {
        id: parent.id,
        title: "Specified",
        summary: "Ready to split.",
      }),
    );
    expect(specified.card).toMatchObject({ title: "Specified", status: "todo" });

    const decomposed = readPayload(
      await tools.get("workboard_decompose")?.execute("call-decompose", {
        id: parent.id,
        summary: "Split.",
        children: [{ title: "Child A" }, { title: "Child B" }],
      }),
    );
    expect(decomposed.parent).toMatchObject({ status: "done" });
    expect(decomposed.children).toEqual([
      expect.objectContaining({ title: "Child A" }),
      expect.objectContaining({ title: "Child B" }),
    ]);

    const runs = readPayload(
      await tools.get("workboard_runs")?.execute("call-runs", { id: parent.id }),
    );
    expect(runs.attempts).toEqual([]);

    const subscription = readPayload(
      await tools.get("workboard_notify_subscribe")?.execute("call-subscribe", {
        boardId: "planning",
        cardId: parent.id,
        target: "session:operator",
        eventKinds: ["completed"],
      }),
    );
    expect(subscription.subscription).toMatchObject({
      boardId: "planning",
      cardId: parent.id,
      target: "session:operator",
      eventKinds: ["completed"],
    });

    const list = readPayload(
      await tools.get("workboard_notify_list")?.execute("call-notify-list", {
        boardId: "planning",
      }),
    );
    expect(list.subscriptions).toEqual([
      expect.objectContaining({ cardId: parent.id, target: "session:operator" }),
    ]);

    const events = readPayload(
      await tools.get("workboard_notify_advance")?.execute("call-notify-events", {
        subscriptionId: (subscription.subscription as { id: string }).id,
      }),
    );
    expect(events.events).toEqual([expect.objectContaining({ kind: "completed" })]);

    const attached = readPayload(
      await tools.get("workboard_attachment_add")?.execute("call-attach", {
        id: parent.id,
        fileName: "result.txt",
        contentBase64: Buffer.from("done").toString("base64"),
      }),
    );
    expect(attached.card).toMatchObject({
      metadata: { attachments: [expect.objectContaining({ fileName: "result.txt" })] },
    });
    const attachments = (attached.card as { metadata: { attachments: Array<{ id: string }> } })
      .metadata.attachments;
    const attachmentId = expectDefined(attachments[0], "workboard attachment").id;
    const attachment = readPayload(
      await tools.get("workboard_attachment_read")?.execute("call-attachment-read", {
        id: attachmentId,
      }),
    );
    expect(Buffer.from(attachment.contentBase64 as string, "base64").toString("utf8")).toBe("done");
  });

  it("moves cards with agent claim scope", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = { runtime: {} } as unknown as OpenClawPluginApi;
    const tools = new Map(
      createWorkboardTools({ api, store, context: { agentId: "agent-b" } as never }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const card = await store.create({ title: "Move tool card", status: "todo" });

    const unclaimed = readPayload(
      await tools.get("workboard_move")?.execute("move-unclaimed", {
        id: card.id,
        status: "ready",
      }),
    );
    expect(unclaimed.card).toMatchObject({ status: "ready" });

    await store.claim(card.id, { ownerId: "agent-a", token: "test-auth-token" });
    await expect(
      tools.get("workboard_move")?.execute("move-denied", {
        id: card.id,
        status: "review",
      }),
    ).rejects.toThrow("card is claimed by agent-a");

    const claimed = readPayload(
      await tools.get("workboard_move")?.execute("move-claimed", {
        id: card.id,
        status: "review",
        token: "test-auth-token",
      }),
    );
    expect(claimed.card).toMatchObject({ status: "review" });
  });

  describe("workboard_complete evidence gate", () => {
    // Between 2026-07-21 and 2026-08-04, 31 cards reached `done` through this
    // tool with zero proof entries. The closer and the CLI both refused a
    // completion carrying nothing checkable; this tool did not, and the
    // dispatcher prompt points every worker at it.
    async function claimedCard(env?: string) {
      if (env === undefined) delete process.env.OPENCLAW_WORKBOARD_REQUIRE_PROOF;
      else process.env.OPENCLAW_WORKBOARD_REQUIRE_PROOF = env;
      const store = new WorkboardStore(createMemoryStore());
      const api = { runtime: {} } as unknown as OpenClawPluginApi;
      const tools = new Map(
        createWorkboardTools({ api, store, context: { agentId: "main" } }).map((t) => [t.name, t]),
      );
      const created = readPayload(
        await tools.get("workboard_create")?.execute("c", { title: "Work", agentId: "main" }),
      );
      const id = (created.card as { id: string }).id;
      const claimed = readPayload(await tools.get("workboard_claim")?.execute("k", { id }));
      return { tools, id, token: (claimed.token as string | undefined) ?? "" };
    }

    it("refuses a completion carrying only prose", async () => {
      const { tools, id, token } = await claimedCard("enforce");
      await expect(
        tools.get("workboard_complete")?.execute("x", {
          id,
          token,
          summary: "Ran the suite, everything passed, 158/158.",
          proof: { status: "passed", note: "all green" },
        }),
      ).rejects.toThrow(/no verifiable evidence/);
    });

    it("accepts a command or a url", async () => {
      // proofId is not tested here: the store requires an accompanying proof
      // object whenever one is supplied, so the object is always what the gate
      // judges. That is why proofId is not a pass condition of its own.
      for (const evidence of [
        { proof: { command: "npm test # card abc" } },
        { proof: { url: "https://github.com/o/r/pull/1" } },
        { proof: { status: "passed", label: "suite", command: "vitest run" } },
      ]) {
        const { tools, id, token } = await claimedCard("enforce");
        const done = readPayload(
          await tools.get("workboard_complete")?.execute("x", { id, token, ...evidence }),
        );
        expect(done.card).toMatchObject({ status: "done" });
      }
    });

    it("noProofReason always completes and records the absence as auditable", async () => {
      const { tools, id, token } = await claimedCard("enforce");
      const done = readPayload(
        await tools.get("workboard_complete")?.execute("x", {
          id,
          token,
          summary: "Read-only investigation.",
          noProofReason: "discussion card — nothing to run or open",
        }),
      );
      const card = done.card as { status: string; metadata?: { proof?: unknown[] } };
      expect(card.status).toBe("done");
      // The escape hatch must not become a silent bypass: the reason is written
      // where the done-without-proof audit can see it.
      const proof = (card.metadata?.proof ?? []) as Array<Record<string, unknown>>;
      expect(proof).toHaveLength(1);
      expect(proof[0]).toMatchObject({ status: "unknown" });
      expect(String(proof[0].note)).toContain("discussion card");
    });

    it("warn mode completes but still records the absence", async () => {
      const { tools, id, token } = await claimedCard("warn");
      const done = readPayload(
        await tools.get("workboard_complete")?.execute("x", { id, token, summary: "done" }),
      );
      const card = done.card as { status: string; metadata?: { proof?: unknown[] } };
      expect(card.status).toBe("done");
      const proof = (card.metadata?.proof ?? []) as Array<Record<string, unknown>>;
      expect(proof).toHaveLength(1);
      expect(proof[0]).toMatchObject({ status: "unknown" });
    });

    it("off mode restores legacy behavior: proofless completion, no entry", async () => {
      const { tools, id, token } = await claimedCard("off");
      const done = readPayload(
        await tools.get("workboard_complete")?.execute("x", { id, token, summary: "done" }),
      );
      const card = done.card as { status: string; metadata?: { proof?: unknown[] } };
      expect(card.status).toBe("done");
      expect(card.metadata?.proof ?? []).toHaveLength(0);
    });

    it("defaults to enforce when the variable is unset", async () => {
      const { tools, id, token } = await claimedCard(undefined);
      await expect(
        tools.get("workboard_complete")?.execute("x", { id, token, summary: "done" }),
      ).rejects.toThrow(/no verifiable evidence/);
    });
  });
});
