<!--
  SERVER-SIDE MIRROR (child contract) for CI verification.
  Authoritative source: Olivaryne/veelo contracts/review/ot-gov-4-worker-start-authority.v1.md
  at freeze commit 71985e16717d31f95ab0dd5d8be80493de1201f9
  (source sha256 c12d43e63f2751cc8a06747c3ab77d8f28d6a3cca192bc29d6057e0fe2bfb13e).
  This file is a verbatim byte copy of the frozen parent below this header,
  mirrored so the governed CI can verify contract bytes without private-repo
  access. Never edited in place; a parent v2 produces a new mirror.
  Committed with the format hook bypassed: formatting a frozen contract
  changes its bytes, and the bytes are the authority.
-->

# OT-GOV-4 — frozen implementation contract (v1): atomic per-card worker-start authority

**Issue:** [#433](https://github.com/Olivaryne/veelo/issues/433) — OT-GOV-4: atomic per-card worker-start authority (contract freeze)
**Workboard card:** `bf276b9f-350c-4fa8-81b6-1fb5b2e9a6d1` — `todo`, `hold`, `operator-merge-only`, unassigned, unclaimed, dispatch-ineligible.
**Parents:** OT-GOV-1 `11460e65`, OT-GOV-2 `63239baf`, OT-GOV-3 `37cc059d` · **Program:** [#380](https://github.com/Olivaryne/veelo/issues/380) Phase 0
**Predecessor spec:** `docs/architecture/workboard-worker-start-authority.md` §3 (proposal; superseded by this document)
**Precedent:** AUT-WB-ATOMIC — `docs/architecture/aut-wb-atomic-create-or-recover-contract.md`, implemented as `Olivaryne/openclaw-veelo@veelo-main` `8bb849bfbd47b1de2b22ec4a671b76b9d0388962`
**Veelo base:** `14bf9699d69ba24e296f305f4f95dc0b54ab9677` (exact `main`)
**Server base:** `8bb849bfbd47b1de2b22ec4a671b76b9d0388962` (exact `veelo-main`, installed as `openclaw 2026.7.1 (8bb849b)`)

**STATUS: FROZEN.** The operator granted all six §14 approvals on 2026-08-02. This is the authoritative review contract for OT-GOV-4b `f9c77689`. It is never edited in place; any change produces a v2 file with its own freeze record.

## 1. Objective

Provide one server-authoritative, atomic, per-card worker-start operation —
`startCardIfEligible` — as the **sole** production boundary through which any
automated actor may start a Workboard worker.

The operation must, in one serialized transaction, re-read live card state, reject
operator-protected cards, verify dependency state, compare-and-swap against the
caller's expected state, reject a live claim or active execution, and reserve
exactly one start. Only after that reservation commits may a worker be created.

This closes the last structural gap in the OT-GOV line. OT-GOV-3 proved that
`dispatchAndStartWorkboardCards` scopes only the *promote* to `boardId` while its
worker-start loop iterates `store.list()` unscoped and unfiltered, so dispatching a
safe board started a held card on a protected board (proven live 2026-07-23).
OT-GOV-3 contained that by removing every dispatch call from the Veelo runner and
freezing `SUPPORTED_AUTHORITIES` to `{"disabled"}`. Containment is not capability:
Veelo currently cannot start a worker at all, and every downstream item in program
#380 (AUT-004, AUT-005, SKL-001, SKL-002) is blocked behind this contract.

**The existing claim path cannot be the authority.** `WorkboardStore.claim()`
(`extensions/workboard/src/store.ts:4262`) runs inside `enqueueMutation`, the
**process-local** mutation queue, and performs read-check-write across `await`
boundaries with no SQLite transaction and no compare-and-swap:

```ts
const existingClaim = guarded.metadata?.claim;
if (existingClaim && isFutureDateTimestampMs(existingClaim.expiresAt, { nowMs: now })) {
  throw new Error(`card already claimed by ${existingClaim.ownerId}.`);
}
```

Two processes can both pass that check. This is the identical defect class
AUT-WB-ATOMIC was created to fix for card creation, and it is why the alternative
route in the predecessor spec — a Veelo-owned CJS authority layered on `claim()` —
is not viable: it inherits the defect, and direct SQLite mutation from Veelo is
prohibited. The authority must live in the store, beside the atomic create.

## 2. Explicit non-goals

- No re-enablement of global or board-scoped OpenClaw dispatch. `workboard dispatch`
  and `workboard.cards.dispatch` remain unreachable from the Veelo production runner.
- No scheduler, no timer, no cron surface, no AUT-004 start integration, no AUT-005
  canary, no automation-definition registry work.
- No Veelo production caller. This contract delivers a server capability and the
  Veelo-side authority-token change **only**; nothing calls it in production.
- No Veelo-owned CJS start authority, and no direct SQLite access from Veelo.
- No change to AUT-WB-ATOMIC's request/response, schema-3 objects, or receipts.
- No change to the semantics of `claim`, `reclaim`, `promoteReady`, `complete`,
  `block`, or existing attempt accounting beyond the additive surfaces in §12.
- No modification of the existing `dispatchAndStartWorkboardCards` start loop. It
  stays defective and stays unreachable from production; narrowing it is a separate,
  optional upstream contribution.
- No publication of the upstream OpenClaw issue draft in
  `docs/architecture/workboard-worker-start-authority.md` §4.

## 3. One authoritative state boundary

The OpenClaw Workboard **SQLite service** is the single authoritative boundary, as
it already is for AUT-WB-ATOMIC.

The mutual-exclusion point is a row in a new `workboard_card_start_reservations`
table, protected by a **partial unique index permitting at most one unreleased
reservation per card**. Insertion of that row inside `BEGIN IMMEDIATE` is what
makes the start exclusive. Compare-and-swap on expected card state is a
**staleness check that precedes** the insert; it is never the exclusion mechanism.

No production correctness may depend on `enqueueMutation`, a host advisory lock, a
process mutex, caller memory, or a client-side read-then-write sequence. Like
`createOrRecoverByCorrelationKey`, the new method deliberately bypasses the
process-local mutation queue.

**Worker creation is outside the transaction and therefore outside the atomic
guarantee.** The guarantee this boundary provides is **at most one** started worker
per reservation, never *exactly* one. A crash after the reservation commits and
before the worker exists leaves an orphaned reservation, and the defined recovery
is a neutral release (§10), never a second start.

## 4. Permitted effects

Inside the single transaction, and only on a fully validated request:

- insert exactly one `workboard_card_start_reservations` row binding `card_id`,
  `attempt_id`, `authority_id`, and the reserved-at timestamp;
- insert exactly one `workboard_card_attempts` row in status `reserved`, bound to
  the reservation;
- transition the card's status to the reserved-start status and set its claim to the
  reserving authority, with the existing claim TTL semantics;
- append one card event recording the reservation;
- append one **append-only** start receipt resolvable through a dedicated lookup.

After the transaction commits, and only then, the gateway handler may create the
worker and bind its execution identity to the reservation.

## 5. Prohibited effects

- Starting, claiming, promoting, or mutating a card carrying `hold`,
  `operator-merge-only`, or `operator-controlled`, or in status `review`.
- Starting a card whose parents are not `done`, or whose `required_dependency_state`
  is unmet.
- Creating a second worker for a reservation that already has one.
- Any mutation whatsoever on a refusal. Every refusal is a pure read.
- Incrementing `failureCount`, or writing an attempt in status `failed`, as a result
  of a neutral release, a cancellation, or an orphaned-reservation recovery.
- Invoking a model or provider, sending externally, writing to a repository, or
  touching a timer.
- Reading or writing the Workboard SQLite file from Veelo.
- Any client-supplied value being trusted as authority: `authority_id` is recorded
  as provenance and is never a permission.

## 6. Exact invariants

1. At most one unreleased start reservation exists per card at any instant, enforced
   by a partial unique index, not by application logic.
2. The same `(card_id, attempt_id)` reserves at most once. A replay returns the
   existing reservation with a `recovered` outcome and creates nothing.
3. Two concurrent callers in separate OS processes with identical valid requests
   produce exactly one reservation, exactly one attempt row, and exactly one
   `reserved` outcome; the loser receives a typed refusal or a `recovered` outcome
   for its own `attempt_id`.
4. Request validation completes before any lookup or write; an invalid request
   performs zero reads of reservation state and zero writes.
5. A card carrying any forbidden label, or in `review`, is refused, and this
   outranks every other check except request validity.
6. A CAS mismatch on `expected_status` or `expected_updated_at` refuses without
   mutation, even when every other precondition passes.
7. A live claim or an active execution refuses without mutation.
8. On any refusal the card row, its labels, its attempts, its claim, its metadata,
   its events, and the reservation table are byte-identical to their pre-call state.
9. Reservation, attempt row, card transition, event, and receipt are committed by
   one transaction or none of them are.
10. A neutral release clears the claim, closes the attempt as `stopped`, marks the
    reservation released, and leaves `failureCount` unchanged.
11. A released reservation is never reused; a subsequent start requires a new
    `attempt_id` and produces a new reservation row.
12. Start receipts are append-only, enforced by database triggers that refuse
    `UPDATE` and `DELETE`, mirroring `workboard_atomic_create_receipts`.
13. No reachable code path allows a generic `update`, `claim`, or `dispatch` call to
    create, alter, or release a start reservation.
14. Every terminal refusal carries a stable reason code from §8 and `evidence: null`
    unless a durable receipt exists to reference.
15. With the schema absent or refused, the method returns
    `workboard_start_migration_required` and every pre-existing surface — including
    `claim`, `reclaim`, and `complete` — continues to work unchanged.

## 7. Request and response contracts

Store method:

```
startCardIfEligible(request) -> StartCardResponseV1
```

Gateway methods:

```
workboard.cards.startIfEligible
workboard.cards.releaseStartReservation
workboard.startReceipts.get
```

Frozen request, closed set — unknown, missing, or malformed fields are invalid:

```
{
  schema_version: 1,
  card_id: string,                       // exact card id, never a prefix
  attempt_id: string,                    // caller-generated lowercase RFC-4122 UUID
  authority_id: string,                  // provenance only, never permission
  expected_status: string,               // CAS
  expected_updated_at: integer,          // CAS, milliseconds
  required_dependency_state: "all_parents_done" | "none",
  forbidden_labels: string[],            // MUST include hold, operator-merge-only,
                                         // operator-controlled; server refuses a
                                         // request that omits any of them
  expected_assignee: string | null,
  worker: {                              // recorded with the reservation; the
    engine: string,                      // boundary never invokes it
    mode: string,
    model: string | null,
    session_key: string | null
  }
}
```

Frozen response envelope, closed set:

```
{
  schema_version: 1,
  ok: boolean,
  outcome: "reserved" | "recovered" | "refused" | "failed",
  reason_code: string,                   // §8
  retryable: boolean,                    // §9
  card_id: string | null,
  reservation: {
    reservation_id: string,
    attempt_id: string,
    authority_id: string,
    reserved_at: integer,
    expires_at: integer,
    worker_bound: boolean
  } | null,
  card: WorkboardStartCardProjectionV1 | null,
  evidence: { kind: "workboard_start_receipt", ref: string } | null
}
```

`WorkboardStartCardProjectionV1` is a closed projection carrying `id`, `board_id`,
`status`, `labels`, `agent_id`, `claim`, `execution`, `started_at`, and
`updated_at`. `forbidden_labels` is echoed back so a caller can prove which
protection set the server applied.

The release request is `{ schema_version: 1, reservation_id, attempt_id, reason }`
and returns the same envelope shape with outcome `released` or a typed refusal.

## 8. Stable typed outcomes

Success:

- `workboard_start_reserved`
- `workboard_start_recovered`
- `workboard_start_released`

Terminal refusals:

- `workboard_start_request_invalid`
- `workboard_start_card_not_found`
- `workboard_start_card_protected`
- `workboard_start_dependencies_unsatisfied`
- `workboard_start_state_conflict`
- `workboard_start_already_claimed`
- `workboard_start_active_execution`
- `workboard_start_already_reserved`
- `workboard_start_retry_budget_exhausted`
- `workboard_start_stored_record_invalid`
- `workboard_start_migration_required`

Retryable failures:

- `workboard_unavailable`
- `workboard_storage_failure` (only when rollback is confirmed)
- `workboard_result_uncertain`

## 9. Retryable versus terminal outcomes

`retryable: true` is permitted **only** for `workboard_unavailable`,
`workboard_storage_failure`, and `workboard_result_uncertain`. Every refusal in the
terminal list is `retryable: false`, including `workboard_start_state_conflict`: a
CAS mismatch means the caller's view is stale, so the correct client behaviour is to
re-read and decide again, never to retry the same request.

`workboard_result_uncertain` obliges the caller to replay the **same**
`(card_id, attempt_id)`, which resolves to `workboard_start_recovered` if the
reservation committed and to a fresh attempt if it did not. No blind-retry path may
exist.

## 10. Race, crash, restart, and interruption points

Each point below must be provable by an executed test, not by argument.

- Two OS processes issuing identical valid requests concurrently; and 16 concurrent
  callers on one card.
- Interruption before `COMMIT`: nothing persists; a replay reserves cleanly.
- Interruption after `COMMIT`, before the response reaches the caller: replay of the
  same `attempt_id` returns `recovered`.
- Interruption after `COMMIT`, before worker creation: the reservation is orphaned.
  Recovery is a neutral release, never an implicit second start. The orphan must be
  detectable by reservation age against `expires_at`.
- Worker creation fails after a committed reservation: the handler neutrally
  releases and returns a retryable failure.
- Service restart with an unreleased, unexpired reservation: the reservation
  survives, still blocks a second start, and is releasable.
- Cancellation before reservation refuses; cancellation after reservation but before
  worker creation neutrally releases.
- A concurrent `claim`, `reclaim`, `block`, or `complete` racing the reservation.
- A concurrent operator applying `hold` between the caller's read and its call: CAS
  on `expected_updated_at` refuses.

## 11. Adversarial acceptance matrix

Every row must be an executed test through the public gateway boundary with
persisted-state invariants asserted, not a unit test of an internal helper.

| # | Case | Required outcome |
| --- | --- | --- |
| 1 | Valid request, eligible card | `reserved`, one reservation, one attempt |
| 2 | Replay of same `(card_id, attempt_id)` | `recovered`, no second row |
| 3 | Two processes, identical requests | exactly one `reserved` |
| 4 | 16 concurrent callers, distinct `attempt_id` | one `reserved`, 15 refused `already_reserved` |
| 5 | Card labelled `hold` | `card_protected`, zero mutation |
| 6 | Card labelled `operator-merge-only` | `card_protected`, zero mutation |
| 7 | Card labelled `operator-controlled` | `card_protected`, zero mutation |
| 8 | Card in `review` | `card_protected`, zero mutation |
| 9 | Request omitting a mandatory forbidden label | `request_invalid`, zero reads of reservation state |
| 10 | Parent card not `done` | `dependencies_unsatisfied` |
| 11 | `required_dependency_state: "none"` with unmet parents | `reserved` only if no other rule refuses |
| 12 | `expected_status` mismatch | `state_conflict`, zero mutation |
| 13 | `expected_updated_at` mismatch | `state_conflict`, zero mutation |
| 14 | Label applied between caller read and call | `state_conflict` |
| 15 | Live unexpired claim present | `already_claimed` |
| 16 | Expired claim present | `reserved` |
| 17 | Active execution present | `active_execution` |
| 18 | Retry budget exhausted | `retry_budget_exhausted` |
| 19 | Unknown card id | `card_not_found` |
| 20 | Card id prefix instead of exact id | `request_invalid` |
| 21 | Unknown field anywhere in the request | `request_invalid` |
| 22 | Missing field anywhere in the request | `request_invalid` |
| 23 | Malformed `attempt_id` (non-UUID, uppercase) | `request_invalid` |
| 24 | Stored reservation row corrupted | `stored_record_invalid`, no repair |
| 25 | Schema-4 absent | `migration_required`, legacy surfaces unaffected |
| 26 | Schema-4 partially applied | `migration_required`, never repaired |
| 27 | Crash before `COMMIT` | nothing persists; replay reserves |
| 28 | Crash after `COMMIT`, before response | replay returns `recovered` |
| 29 | Crash after `COMMIT`, before worker creation | orphan detectable; neutral release |
| 30 | Worker creation throws | neutral release, retryable failure |
| 31 | Neutral release | claim cleared, attempt `stopped`, `failureCount` unchanged |
| 32 | Release of an already-released reservation | typed refusal, no second effect |
| 33 | Reuse of a released `attempt_id` | `request_invalid` |
| 34 | Service restart with live reservation | reservation survives and still blocks |
| 35 | Generic `update` attempting to write reservation columns | refused by trigger |
| 36 | `UPDATE` or `DELETE` on a start receipt | refused by trigger |
| 37 | Direct `claim` racing a reservation | one winner, no double start |
| 38 | Spy assertion: no model, provider, network, or timer call on any path | zero calls |
| 39 | Spy assertion: no `dispatch` or `promote` reachable from the method | zero calls |
| 40 | Rollback binary opens schema-4 and preserves reservation rows | verified |

## 12. Migration requirements

One additive migration recording both `schema-4` and the feature-specific
`schema-4-ot-gov-4`, mirroring the schema-3 ledger convention already live
(`{schema-2, schema-3, schema-3-aut-wb-atomic}`).

It must add:

- `workboard_card_start_reservations(reservation_id TEXT PRIMARY KEY, card_id TEXT
  NOT NULL REFERENCES workboard_cards(id), attempt_id TEXT NOT NULL, authority_id
  TEXT NOT NULL, reserved_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  worker_bound INTEGER NOT NULL DEFAULT 0, released_at INTEGER, release_reason TEXT)`;
- `UNIQUE(card_id, attempt_id)`;
- a partial unique index `ON workboard_card_start_reservations(card_id) WHERE
  released_at IS NULL` — the exclusion point;
- `workboard_start_receipts`, append-only, with `_no_update` and `_no_delete`
  triggers matching the `workboard_atomic_create_receipts` pattern;
- a trigger refusing physical `DELETE` of a card holding an unreleased reservation.

`workboard_card_attempts` currently carries **no** unique constraint beyond its
primary key, and its live statuses are `blocked`, `stopped`, `succeeded`. Adding
`reserved` is an additive status value; no existing row is rewritten.

The migration runs transactionally before the new methods register, refuses any
unexpected schema state, and is never repaired in place. Interruption before commit
rolls back and reruns safely. It must execute cleanly against a `.backup` snapshot
of the **live** database before the implementation PR is submitted — the AUT-WB-ATOMIC
round proved that fixture-only migration evidence leaves a real gap.

## 13. Rollback boundary

Rollback is to the exact previously installed binary, currently
`openclaw 2026.7.1 (8bb849b)`, retained at
`~/.veelo/backups/aut-wb-atomic-20260802/openclaw-2026.7.1.tgz`.

The implementation must prove, against that exact binary and a temporary schema-4
database, that the old bundle opens and reads schema 4, that generic upsert
preserves reservation rows, and that a card holding an unreleased reservation cannot
be physically deleted. Schema-4 must be forward-compatible so that a binary rollback
never requires restoring the database.

Rollback is permitted only with all start callers disabled, which on this contract is
the default: the Veelo authority token stays `disabled` until §14.4 is granted.

## 14. Required operator approvals

**All six granted by the operator on 2026-08-02.** The grant covers these decisions
only. It authorizes the freeze, and through the freeze it authorizes work to begin on
card OT-GOV-4b `f9c77689` under this contract. It authorizes no deployment, no
installation, no live migration, no canary, no activation, and no change to
`SUPPORTED_AUTHORITIES` outside the conditions in decision 4.

1. **Route.** APPROVED. Approve implementing the authority server-side in the Veelo-owned
   OpenClaw fork, superseding the predecessor spec's two-route choice. Route 2
   (Veelo CJS authority over `claim()`) is recorded as non-viable in §1.
2. **Exclusion model.** APPROVED. Approve the partial-unique-index reservation table as the
   mutual-exclusion point, with CAS as a staleness check only.
3. **At-most-once semantics.** APPROVED. Acknowledge that a crash between commit and worker
   creation yields an orphaned reservation recovered by neutral release, and that
   exactly-once start is not offered.
4. **Authority token.** APPROVED. Approve adding exactly one new member to
   `SUPPORTED_AUTHORITIES` in `agent_core/tools/workboard/worker_start_authority.cjs`,
   landing **in the same PR as a real atomic starter** and defaulting to `disabled`.
5. **Receipt retention.** APPROVED. Approve append-only start-receipt retention.
6. **Canary.** APPROVED. Approve that no canary, activation, or AUT-004 integration is included
   here and each requires separate authorization.

## 15. Freeze point

- **Contract version:** v1
- **Frozen at:** 2026-08-02, on the operator's grant of all six §14 approvals.
- **Frozen by:** Claude (contract author), on operator authorization.
- **Freeze record (immutable bytes, required):**
  `contracts/review/ot-gov-4-worker-start-authority.v1.md@<SHA of the freeze commit>`
  — the concrete 40-character SHA is published in issue #433 and on Workboard card
  `bf276b9f-350c-4fa8-81b6-1fb5b2e9a6d1` immediately after the freeze commit lands.
  A commit cannot contain its own hash, so it cannot be embedded here.
- **Anchors carried by the freeze record:** Veelo base
  `14bf9699d69ba24e296f305f4f95dc0b54ab9677`; server base
  `8bb849bfbd47b1de2b22ec4a671b76b9d0388962`.
- **Convenience pointers (optional, non-authoritative):** program tracker #380;
  predecessor spec `docs/architecture/workboard-worker-start-authority.md` §3; brain
  page `agent_core/workspace/brain/decisions/2026-08-02-ot-gov-4-start-authority.md`.
- **Version / reset rule:** any change to this contract after the freeze commit
  produces `ot-gov-4-worker-start-authority.v2.md` as a new frozen file with its own
  record; this file is never edited in place; review rounds count per version.
- **Prior versions:** none. `docs/architecture/workboard-worker-start-authority.md`
  §3 is a **proposal**, not a frozen contract version: it is superseded by this
  document and is not carried forward, referenced as authority, or amended.

Submissions against this contract are validated locally by
`agent_core/tools/review/validate_submission.cjs` (REV-STD-002) before any review is
requested. This document is written to that validator's required section template and
parses against it with zero structural findings.

## 16. PR sizing and split triggers

One implementation PR against the fork, confined to the AUT-WB-ATOMIC file budget:

```
extensions/workboard/src/types.ts
extensions/workboard/src/sqlite-store.ts
extensions/workboard/src/store.ts
extensions/workboard/src/gateway.ts
extensions/workboard/src/store.test.ts
extensions/workboard/src/sqlite-store.test.ts
extensions/workboard/src/gateway.test.ts
```

The Veelo-side authority-token change (§14.4) is a **separate** PR against `veelo`,
touching only `worker_start_authority.cjs`, its tests, the brain page, and a handoff.

Split triggers: any change to `dispatchAndStartWorkboardCards`; any change to
existing `claim` or `reclaim` semantics beyond additive reservation awareness; any
Veelo production caller; any scheduler, canary, or dashboard surface. Each of those
is a new card, not a larger PR.

## 17. Reviewer identity and role separation

- **Implementer:** Claude
- **Independent reviewer:** a fresh context that authored no part of this contract or
  its implementation. Codex is the default; if Codex is unavailable, a fresh Claude
  context that has never seen this branch may review, and its independence must be
  stated explicitly in the verdict.
- Confirmed: the contract author does not clear the implementation, and the
  implementer submits evidence only (REV-STD-001 §6). No reviewer disposition,
  clearance, or verdict language may be authored by the implementer anywhere on the
  branch.

Round 1 is one complete independent review against this frozen contract. Governed CI
(`.github/workflows/openclaw-veelo-ci.yml`) must pass at the exact reviewed head, and
its receipt artifact must be independently downloaded and its digests recomputed, as
was done for AUT-WB-ATOMIC PR #7. Merge is operator-only.

## 18. Maximum review-round policy

Two rounds. Round 1 is a complete independent review; Round 2 verifies corrections
only. A blocker surviving Round 2 exhausts the budget and forces a PR split, an
implementer swap, or architecture escalation — never a third correction pass on the
same PR. Stronger non-critical guarantees become follow-up cards rather than
expanding review criteria mid-round.
