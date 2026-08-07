// Workboard plugin module implements gateway behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "../api.js";
import {
  buildExecution,
  buildSessionKey,
  buildWorkerPrompt,
  dispatchAndStartWorkboardCards,
  materializeWorkspace,
} from "./dispatcher.js";
import { buildAtomicEnvelope, isAtomicCorrelationKey, WorkboardStore } from "./store.js";
import { WORKBOARD_STATUSES, type WorkboardCard } from "./types.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function respondError(respond: GatewayRespond, error: unknown) {
  respond(false, undefined, {
    code: "workboard_error",
    message: formatErrorMessage(error),
  });
}

/*
 * Who is asking. Recorded on the card event so a mutation can be traced after
 * the fact.
 *
 * On 2026-08-07 an unidentified caller closed two cards without evidence and
 * archived 29 more. Every known writer was ruled out one by one — the Veelo
 * archive run's own manifest, the board hygienist, the dispatch lane — and the
 * incident still ended unattributed, because card events record what changed
 * and when but never who. An hour of elimination produced no answer.
 *
 * Prefers the agent runtime identity (the gateway proves it via a signed
 * token); falls back to the client id and mode the connection declared, which
 * is self-reported and should be read as a hint, not proof. `sessionKey` is
 * truncated: enough to correlate two mutations from one session without
 * copying a full key onto every card.
 */
function actorOf(client: { connect?: unknown; internal?: unknown } | null | undefined): string {
  if (!client) {
    return "unknown";
  }
  const internal = client.internal as
    | { agentRuntimeIdentity?: { agentId?: string; sessionKey?: string } }
    | undefined;
  const identity = internal?.agentRuntimeIdentity;
  if (identity?.agentId) {
    const session = identity.sessionKey ? `/${identity.sessionKey.slice(0, 12)}` : "";
    return `agent:${identity.agentId}${session}`;
  }
  const connect = client.connect as { client?: { id?: string; mode?: string } } | undefined;
  const declared = connect?.client;
  if (declared?.id) {
    return `client:${declared.id}${declared.mode ? `/${declared.mode}` : ""}`;
  }
  return "unknown";
}

function readId(params: Record<string, unknown>): string {
  const value = params.id;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error("id is required.");
}

function readPatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch = params.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return patch as Record<string, unknown>;
  }
  return params;
}

function assertNoCursorAdvance(params: Record<string, unknown>) {
  if (params.advance === true) {
    throw new Error("notification cursor advancement requires workboard.notifications.advance.");
  }
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: { ...claim, token: "[redacted]" },
    },
  };
}

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactClaimToken(row.card),
    })),
  };
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
}) {
  const { api } = params;
  const store = params.store ?? WorkboardStore.openSqlite();

  api.registerGatewayMethod(
    "workboard.cards.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          // `labels` narrows the result set BEFORE serialization, which is the
          // point: a caller after one fingerprinted card should not receive —
          // or have to buffer — the whole board.
          cards: (
            await store.list({
              boardId: requestParams.boardId,
              labels: requestParams.labels,
            })
          ).map(redactClaimToken),
          statuses: WORKBOARD_STATUSES,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.create",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { card: redactClaimToken(await store.create(requestParams)) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.update",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.update(readId(requestParams), readPatch(requestParams), actorOf(client)),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.move",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.move(
              readId(requestParams),
              requestParams.status,
              requestParams.position,
              actorOf(client),
            ),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.delete(readId(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.comment",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addComment(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.link",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addLink(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.linkDependency",
    async ({ params: requestParams, respond }) => {
      try {
        const parentId = requestParams.parentId;
        const childId = requestParams.childId;
        if (typeof parentId !== "string" || typeof childId !== "string") {
          throw new Error("parentId and childId are required.");
        }
        respond(true, {
          card: redactClaimToken(await store.linkCards(parentId, childId)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.proof",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addProof(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.artifact",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addArtifact(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.claim",
    async ({ params: requestParams, respond }) => {
      try {
        const claimed = await store.claim(readId(requestParams), requestParams);
        respond(true, { ...claimed, card: redactClaimToken(claimed.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.heartbeat",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.heartbeat(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.release",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.releaseClaim(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.promote",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.promote(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.reassign",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.reassign(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.reclaim",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.reclaim(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.complete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.complete(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.block",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.block(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.unblock",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.unblock(readId(requestParams))),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.bulk",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.bulkUpdate(requestParams);
        respond(true, { cards: result.cards.map(redactClaimToken) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.diagnostics",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await store.diagnostics()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.diagnostics.refresh",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await store.refreshDiagnostics()));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.dispatch",
    async ({ params: requestParams, respond, client }) => {
      try {
        const boardId =
          requestParams && typeof requestParams === "object" && "boardId" in requestParams
            ? requestParams.boardId
            : undefined;
        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: api.runtime.subagent,
          worktrees: api.runtime.worktrees,
          options: {
            boardId: typeof boardId === "string" ? boardId : undefined,
            allowManagedWorktrees:
              Array.isArray(client?.connect?.scopes) &&
              client.connect.scopes.includes("operator.admin"),
          },
        });
        respond(true, {
          ...result,
          promoted: result.promoted.map(redactClaimToken),
          reclaimed: result.reclaimed.map(redactClaimToken),
          blocked: result.blocked.map(redactClaimToken),
          orchestrated: result.orchestrated.map(redactClaimToken),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.list",
    async ({ respond }) => {
      try {
        respond(true, await store.listBoards());
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.upsert",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { board: await store.upsertBoard(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.archive",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          board: await store.archiveBoard(requestParams.id, requestParams.archived),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.boards.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.deleteBoard(requestParams.id));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.stats",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.stats({ boardId: requestParams.boardId }));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.runs",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.runs(readId(requestParams));
        respond(true, { ...result, card: redactClaimToken(result.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.specify",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.specify(readId(requestParams), requestParams, null)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.decompose",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.decompose(readId(requestParams), requestParams, null);
        respond(true, {
          parent: redactClaimToken(result.parent),
          children: result.children.map(redactClaimToken),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.subscribe",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, { subscription: await store.subscribeNotifications(requestParams) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.list",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.listNotificationSubscriptions(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.delete",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.deleteNotificationSubscription(readId(requestParams)));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.events",
    async ({ params: requestParams, respond }) => {
      try {
        assertNoCursorAdvance(requestParams);
        respond(true, await store.notificationEvents(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.notifications.advance",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, await store.advanceNotificationEvents(requestParams));
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.list",
    async ({ params: requestParams, respond }) => {
      try {
        const result = await store.listAttachments(readId(requestParams));
        respond(true, { ...result, card: redactClaimToken(result.card) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.get",
    async ({ params: requestParams, respond }) => {
      try {
        const attachment = await store.getAttachment(readId(requestParams));
        if (!attachment) {
          throw new Error(`attachment not found: ${readId(requestParams)}`);
        }
        respond(true, attachment);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.add",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addAttachment(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.attachments.delete",
    async ({ params: requestParams, respond }) => {
      try {
        const attachmentId = requestParams.attachmentId;
        if (typeof attachmentId !== "string" || !attachmentId.trim()) {
          throw new Error("attachmentId is required.");
        }
        respond(true, {
          card: redactClaimToken(
            await store.deleteAttachment(readId(requestParams), attachmentId.trim()),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.workerLog",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(await store.addWorkerLog(readId(requestParams), requestParams)),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.protocolViolation",
    async ({ params: requestParams, respond }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.recordProtocolViolation(readId(requestParams), requestParams),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.archive",
    async ({ params: requestParams, respond, client }) => {
      try {
        respond(true, {
          card: redactClaimToken(
            await store.archive(readId(requestParams), requestParams.archived, actorOf(client)),
          ),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.export",
    async ({ respond }) => {
      try {
        const exported = await store.exportCards();
        respond(true, { ...exported, cards: exported.cards.map(redactClaimToken) });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  // AUT-WB-ATOMIC boundary (contract aut-wb-atomic/1 §2.1, §8.1). The two methods
  // register only after the store proves the completed schema-3 migration (§6.2 step
  // 10); a store without the SQLite atomic authority exposes no atomic surface and
  // no fallback to generic create exists on any path.
  if (store.supportsAtomicCreate()) {
    api.registerGatewayMethod(
      "workboard.cards.createOrRecoverByCorrelationKey",
      async ({ params: requestParams, respond }) => {
        const paramKeys = Object.keys(requestParams ?? {});
        const closedRequest =
          paramKeys.length === 2 &&
          paramKeys.includes("correlationKey") &&
          paramKeys.includes("cardSpec");
        const requestKey = isAtomicCorrelationKey(requestParams?.correlationKey)
          ? requestParams.correlationKey
          : null;
        if (!closedRequest) {
          respond(true, buildAtomicEnvelope("workboard_create_request_invalid", requestKey));
          return;
        }
        try {
          respond(
            true,
            await store.createOrRecoverByCorrelationKey(
              requestParams.correlationKey,
              requestParams.cardSpec,
            ),
          );
        } catch {
          // The store method returns typed envelopes for every classified failure;
          // anything escaping it leaves the commit status unknowable (§4.2).
          respond(true, buildAtomicEnvelope("workboard_result_uncertain", requestKey));
        }
      },
      { scope: WRITE_SCOPE },
    );

    api.registerGatewayMethod(
      "workboard.atomicCreateReceipts.get",
      async ({ params: requestParams, respond }) => {
        try {
          const paramKeys = Object.keys(requestParams ?? {});
          if (paramKeys.length !== 1 || paramKeys[0] !== "id") {
            throw new Error("atomic receipt lookup accepts exactly {id}.");
          }
          respond(true, await store.getAtomicCreateReceipt(requestParams.id));
        } catch (error) {
          respondError(respond, error);
        }
      },
      { scope: READ_SCOPE },
    );
  }

  // ── OT-GOV-4 boundary (contract v1 §7) ────────────────────────────────────
  //
  // Registered whenever the backing store CAN carry the start authority
  // (SQLite), regardless of schema state, so an absent or partial schema-4
  // answers with the typed migration_required envelope (§6.15) rather than an
  // unknown-method error. Worker creation happens strictly AFTER the
  // reservation commit (§4); a creation failure neutrally releases and returns
  // a retryable failure (§10) — never a second start.
  if (store.hasStartCapability()) {
    api.registerGatewayMethod(
      "workboard.cards.startIfEligible",
      async ({ params: requestParams, respond }) => {
        let response;
        try {
          response = await store.startCardIfEligible(requestParams);
        } catch {
          respond(true, {
            schema_version: 1,
            ok: false,
            outcome: "failed",
            reason_code: "workboard_result_uncertain",
            retryable: true,
            card_id: null,
            reservation: null,
            card: null,
            evidence: null,
          });
          return;
        }
        if (response.reason_code !== "workboard_start_reserved" || !response.reservation) {
          respond(true, response);
          return;
        }
        // Reservation committed — create exactly one worker and bind it.
        const reservation = response.reservation;
        const cardId = response.card_id as string;
        let started: {
          run: { runId: string };
          card: NonNullable<Awaited<ReturnType<typeof store.get>>>;
          sessionKey: string;
        };
        try {
          const card = await store.get(cardId);
          if (!card) {
            throw new Error("reserved card vanished before worker creation");
          }
          const context = await store.buildWorkerContext(cardId);
          const sessionKey = buildSessionKey(card);
          const materialized = await materializeWorkspace({
            card,
            worktrees: api.runtime.worktrees,
            allowManagedWorktrees: false,
          });
          const run = await api.runtime.subagent.run({
            sessionKey,
            message: buildWorkerPrompt({
              card,
              context,
              ownerId: reservation.authority_id,
              token: card.metadata?.claim?.token ?? "",
            }),
            lane: `workboard:start:${cardId}`,
            idempotencyKey: `workboard-start:${cardId}:${reservation.reservation_id}`,
            lightContext: true,
            deliver: false,
            ...(materialized.cwd ? { cwd: materialized.cwd } : {}),
          });
          started = { run, card, sessionKey };
        } catch {
          // §10 — worker CREATION failed after commit: neutral release, then a
          // retryable failure. F9 (Round 1): storage_failure only when the
          // rollback (the release) is CONFIRMED; a failed or refused release
          // leaves the outcome uncertain and the orphan age-detectable.
          let releaseConfirmed: boolean;
          try {
            const released = await store.releaseStartReservation({
              schema_version: 1,
              reservation_id: reservation.reservation_id,
              attempt_id: reservation.attempt_id,
              reason: "worker-creation-failed",
            });
            releaseConfirmed = released.reason_code === "workboard_start_released";
          } catch {
            releaseConfirmed = false;
          }
          respond(true, {
            schema_version: 1,
            ok: false,
            outcome: "failed",
            reason_code: releaseConfirmed
              ? "workboard_storage_failure"
              : "workboard_result_uncertain",
            retryable: true,
            card_id: cardId,
            reservation: null,
            card: null,
            evidence: null,
          });
          return;
        }
        // F3 (Round 1): the worker EXISTS from this point on — bind FIRST,
        // before any further bookkeeping, so no later failure can neutrally
        // release a reservation whose worker is live (release refuses
        // worker_bound=1). Bookkeeping failures below are reported truthfully
        // but never release and never start a second worker.
        const bound = store.bindStartReservationWorker(reservation.reservation_id);
        try {
          await store.update(cardId, {
            sessionKey: started.sessionKey,
            runId: started.run.runId,
            execution: buildExecution({
              card: started.card,
              sessionKey: started.sessionKey,
              runId: started.run.runId,
              model: started.card.execution?.model ?? "unspecified",
              now: Date.now(),
            }),
          });
          await store.addWorkerLog(
            cardId,
            {
              level: "info",
              message: `Start authority reserved ${reservation.reservation_id} and started run ${started.run.runId}.`,
              sessionKey: started.sessionKey,
              runId: started.run.runId,
            },
            {
              ownerId: reservation.authority_id,
              token: started.card.metadata?.claim?.token ?? "",
            },
          );
        } catch {
          // Worker live and bound; execution bookkeeping incomplete. The
          // closer/orphan machinery reconciles from the session record; a
          // release here would be the F3 double-start bug.
        }
        respond(true, {
          ...response,
          reservation: { ...reservation, worker_bound: bound },
        });
      },
      { scope: WRITE_SCOPE },
    );

    api.registerGatewayMethod(
      "workboard.cards.releaseStartReservation",
      async ({ params: requestParams, respond }) => {
        try {
          respond(true, await store.releaseStartReservation(requestParams));
        } catch {
          respond(true, {
            schema_version: 1,
            ok: false,
            outcome: "failed",
            reason_code: "workboard_result_uncertain",
            retryable: true,
            card_id: null,
            reservation: null,
            card: null,
            evidence: null,
          });
        }
      },
      { scope: WRITE_SCOPE },
    );

    api.registerGatewayMethod(
      "workboard.startReceipts.get",
      async ({ params: requestParams, respond }) => {
        try {
          const paramKeys = Object.keys(requestParams ?? {});
          if (paramKeys.length !== 1 || paramKeys[0] !== "id") {
            throw new Error("start receipt lookup accepts exactly {id}.");
          }
          respond(true, await store.getStartReceipt(requestParams.id));
        } catch (error) {
          respondError(respond, error);
        }
      },
      { scope: READ_SCOPE },
    );
  }
}
