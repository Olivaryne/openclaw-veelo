# AUT-WB-ATOMIC server child contract v1

Status: **FROZEN upon commit. Design-lock extraction only. Authorizes no
implementation, migration, deployment, or activation.**

Child contract version: `aut-wb-atomic-server/1`

## 1. Identity and authority chain

| Item | Value |
| --- | --- |
| Source repository | `Olivaryne/openclaw-veelo` (GitHub fork of `openclaw/openclaw`; remotes: `origin` = Veelo-owned fork, `upstream` = `https://github.com/openclaw/openclaw.git`) |
| Upstream base SHA | `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` (upstream `openclaw/openclaw`; lineage of installed npm `openclaw 2026.7.1-2`) |
| Fork base | `veelo-main` created at exactly the upstream base SHA above |
| Implementation branch | `feat/aut-wb-atomic-srv-1`, branched from `veelo-main` |
| Immutable parent contract | `docs/architecture/aut-wb-atomic-create-or-recover-contract.md@4233aab48219f17f3a8d9ad7d2018c9fc95b93a6` in `Olivaryne/veelo` (66,095 bytes; SHA-256 `c3680fa42c1df3cd156cc57a44230c2cb3f3628a3670d1b2774cc2804c9654e4`) |
| Parent contract version | `aut-wb-atomic/1` |
| Veelo issues | [#380](https://github.com/Olivaryne/veelo/issues/380), [#392](https://github.com/Olivaryne/veelo/issues/392); Workboard prerequisite card `1dd2d965` |
| Governed implementation issue | [Olivaryne/openclaw-veelo#1](https://github.com/Olivaryne/openclaw-veelo/issues/1) |
| Reviewer | Codex, independent from the implementer ([preflight blocker](https://github.com/Olivaryne/veelo/issues/392#issuecomment-5085685229)) |
| Provenance policy | `veelo/PROVENANCE.md` in this repository |

Every parent-section reference below (written `parent §N`) refers exclusively
to the immutable parent contract bytes at the SHA above. This child contract
is a **non-expanding extraction**: it selects and scopes parent requirements;
it defines no new acceptance surface, changes no parent request or response
field, and adds, removes, or renames no reason code.

## 2. Objective

Implement, in this repository's TypeScript source only, the server-authority
phase of the parent contract:

```text
WorkboardStore.createOrRecoverByCorrelationKey(correlationKey, cardSpec)
workboard.cards.createOrRecoverByCorrelationKey
workboard.atomicCreateReceipts.get({id})
```

exactly as the parent defines them, such that concurrent same-key callers
commit at most one card, recovery is server-authoritative, and every outcome
is a closed typed envelope with durable evidence rules.

## 3. Explicit non-goals

This phase does not include, and its PR must not contain:

- any Veelo repository change; AUT-002 compatibility work of any kind
  (parent §3.6 is later-phase scope);
- a production adapter, gateway transport binding, or any Veelo caller;
- installed `dist` patching or importing compiled npm artifacts;
- live database migration execution, installation, deployment, or activation;
- timers, schedules, dispatch, claims, attempt reservation, worker start,
  model/provider calls, or external sends;
- legacy-card adoption or backfill tooling (parent §6.3 fail-closed posture);
- AUT-003;
- any weakening or strengthening of the parent acceptance surface.

## 4. Server authority boundary

Parent §2.1 verbatim in scope: the authoritative boundary is the OpenClaw
Workboard SQLite service. The primitive exists as the store method above and
is exposed through exactly one gateway method. Callers (later phases) never
open or mutate Workboard SQLite directly. Correlation-key scope, grammar
(`^occ_v1_[0-9a-f]{32}$`, ≤39 bytes, equal to
`cardSpec.automation.occurrence_key`), and the global-uniqueness rule are
parent §2.2, unchanged.

## 5. Permitted and prohibited effects

Permitted effects, all inside the parent §2.3 transaction discipline:

- one card insert with canonical governance columns, labels, and created
  event; or receipt-only appends for recovery/refusal outcomes;
- append-only writes to `workboard_atomic_create_receipts`;
- the additive schema-3 migration DDL applied only to test databases in CI.

Prohibited effects: everything in §3 above; any card mutation on refusal or
recovery; any write before validation completes; any successful response
before commit; any reachable execution surface (parent invariant 11); any
generic-create fallback (parent invariants 12, 14, 15).

## 6. Server-owned invariants

Parent §5 invariants 1–18 apply verbatim. This phase must prove them all at
the server boundary, with the caveat that invariant proofs involving a Veelo
caller (caller receipts, adapter mapping) are owned by later phases per the
ownership map. The pristine-state definition (parent §5 closing paragraph) is
adopted unchanged.

## 7. Request and response schemas — by parent reference

- Function arguments: parent §3.1, verbatim.
- `CanonicalAutomationCardSpecV1`: parent §3.2 exact JSON shape and §3.3
  field rules, verbatim, including the AUT-001 reference grammar, secret-shape
  deep scan, and occurrence-key derivation.
- Canonical serialization and fingerprint: parent §3.4, verbatim, including
  the frozen positive vector
  (`occ_v1_7a80f585e84b83e031d3eb8823faaee0`,
  `sha256:952ae4aac535d4220eea7ec6d33c065cb80446e1924c922861802eff62773c6b`)
  and one-byte negative requirements.
- Conflict precedence: parent §3.5, verbatim.
- `AtomicCreateResponseV1`: parent §4.1 exact closed envelope and value
  rules, verbatim.
- `board.ref = "board:" + board.id` deterministic mapping: parent §3.3,
  unchanged.

No field is added, removed, renamed, defaulted, coerced, or aliased. Changing
canonicalization, fingerprint domain, or algorithm is out of scope for v1 in
its entirety (parent §3.4 version rule).

## 8. Exact twelve parent reason codes

The closed set, verbatim from parent §4.2 — no additions, removals, or
renames:

1. `workboard_card_created`
2. `workboard_card_recovered`
3. `workboard_card_conflict`
4. `workboard_create_request_invalid`
5. `workboard_stored_record_invalid`
6. `workboard_card_state_incompatible`
7. `workboard_unavailable`
8. `workboard_storage_failure`
9. `workboard_result_uncertain`
10. `workboard_atomic_migration_required`
11. `workboard_incompatible_legacy_card`
12. `workboard_result_invalid`

`ok`/`outcome`/`retryable` combinations are exactly the parent §4.2 table.
`workboard_result_invalid` is a local Veelo-adapter outcome; the server phase
implements the eleven server-side codes and must never emit
`workboard_result_invalid`, while the response envelope type includes the full
closed set unchanged.

## 9. Schema-3 server responsibilities

Parent §6.1 verbatim: `SCHEMA_VERSION` 2 → 3; ledger rows `schema-3` and
`schema-3-aut-wb-atomic`; the four additive `workboard_cards` columns
(`correlation_key`, `governance_spec_version`, `governance_spec_json`,
`governance_fingerprint`); the unique partial index
`workboard_cards_correlation_key_uq`; the complete/immutable/no-delete
triggers; and the append-only `workboard_atomic_create_receipts` table with
its no-update/no-delete triggers. Migration ordering and interruption behavior
are parent §6.2. Legacy compatibility is parent §6.3 fail-closed refusal —
no adoption, no backfill. **This PR ships migration code and proves it on test
databases only; executing it against any live database is excluded.**

## 10. SQLite atomic transaction responsibility

Parent §2.3 verbatim: complete validation before the transaction; one
`BEGIN IMMEDIATE` transaction covering indexed lookup, legacy detection,
hydration/validation, decision, insert or receipt append, and single commit;
the unique correlation index as final arbiter with loser re-read; no
successful response before commit; `workboard_result_uncertain` when commit
status is unknowable.

## 11. Lifetime correlation-authority responsibility

Parent §6.4 verbatim: the four authority columns are one set-once tuple
populated only by the dedicated atomic insert; generic create/register/upsert
preserve them byte-for-byte; triggers reject partial tuples, clearing,
changing, or rebinding; `workboard.cards.delete` on a correlated card archives
(`{deleted:false, archived:true}`) and physical deletion is trigger-refused;
an archived correlated card returns `workboard_card_state_incompatible` and
never frees its key.

## 12. Receipt and lookup responsibility

Parent §4.3 verbatim: the evidence-ownership table, the exact
`AtomicCreateReceiptV1` projection, `detail_code` slug grammar, and the
read-only `workboard.atomicCreateReceipts.get({id})` primary-key lookup
returning `{schema_version:1, receipt: AtomicCreateReceiptV1 | null}` with no
listing, mutation, or request prose. Server receipts commit in the same
transaction as their outcome. Caller receipts for `null`-evidence outcomes are
later-phase scope exactly as parent §4.3 assigns them.

## 13. Gateway registration responsibility

Parent §2.1 and §8.1: register exactly two methods —
`workboard.cards.createOrRecoverByCorrelationKey` and the read-only
`workboard.atomicCreateReceipts.get` — in `extensions/workboard/src/gateway.ts`
within the existing registration mechanism, with closed response mapping and
typed failure classification (`workboard_unavailable` vs
`workboard_result_uncertain` per parent §4.2). Gateway registration occurs
only after migration verification (parent §6.2 step 10). No other gateway
surface changes.

## 14. Rollback evidence responsibility

Parent §6.5 and row A35: the implementation CI must repeat the design-review
compatibility probe against the exact installed OpenClaw `2026.7.1-2` bundle
lineage as a temporary-fixture test — old binary opens schema 3, retains
ledger rows, generic register preserves the protected tuple byte-for-byte,
correlated delete fails closed — with transcript/digest evidence. Rollback is
binary-only and additive-schema-preserving; destructive downgrade is
prohibited. No other binary is assumed compatible.

## 15. Source and test file budget

Parent §8.1 verbatim, applied to this repository at the fork base:

| File | Budget |
| --- | --- |
| `extensions/workboard/src/types.ts` | Closed request/response/reason-code types only |
| `extensions/workboard/src/sqlite-store.ts` | Schema-3 migration, unique index, protected-tuple/no-delete triggers, receipt table/lookup, indexed transaction |
| `extensions/workboard/src/store.ts` | Validation/canonicalization/fingerprint and public method; no execution imports |
| `extensions/workboard/src/gateway.ts` | Register the two methods; closed response mapping |
| `extensions/workboard/src/store.test.ts` | Request, conflict, legacy, state, no-mutation cases |
| `extensions/workboard/src/sqlite-store.test.ts` | Real SQLite race, crash, restart, migration, rollback compatibility |
| `extensions/workboard/src/gateway.test.ts` | Closed RPC request/response and transport uncertainty |

Four production source files, three focused test files, one additive migration
embedded in the existing Workboard migration mechanism. Generated
bundles/declarations only as normal build output. Any file outside this budget
requires reviewer agreement before submission and must not expand the
acceptance surface. (`sqlite-store.test.ts` may need creation if the base
commit carries only `sqlite-store-policy.test.ts`; that creation stays within
the three-test-file budget.)

## 16. Explicit later-phase exclusions

Per the ownership map (`contracts/automation/aut-wb-atomic-a01-a46-ownership-map.v1.md`):

- **AUT-002 compatibility PR** (Veelo repository, after server release):
  A36, A38, A39, A40, A41 final closure; parent §3.6 items 1–7; caller
  receipts with `request_id` and `getByRequestId()`.
- **Production binding/canary PR** (after both prior merges): A04, A31, A46
  final closure; gateway transport only; no governance reshaping; no
  fallback.
- Installation, live migration execution, deployment, activation, timers,
  dispatch, worker start, and AUT-003 remain separate operator-authorized
  work beyond all three phases (parent §3.6 sequence step 5).

Server-side sub-proofs consumed by later phases (A04 committed-create
same-key recovery; A31 typed unavailable classification with no fallback; A41
OpenClaw vector half; A36-relevant exact server envelopes) are produced in the
server PR without claiming closure of those rows.

## 17. Proof and review policy

- Proof matrix: the implementer completes
  `docs/architecture/aut-wb-atomic-proof-matrix-template.md` (Veelo
  repository, at the parent SHA) per parent §9, including real-SQLite and
  real multi-process evidence; mocks cannot satisfy A01–A07, A31–A35,
  A42–A46, or migration proof.
- Reviewer: Codex, independent from the implementer.
- **Two-round policy** (parent §10 verbatim): Round 1 is one complete review
  at the exact submitted head with completed proof matrix; Round 2 is
  correction verification limited to Round-1 findings; a blocker surviving
  Round 2 forces split/swap/escalation. No open-ended rounds. Review cannot
  approve deployment, migration execution, activation, a production adapter,
  dispatch, worker start, or AUT-003.
- Preflight gate: implementation may not start before Codex issues a PASS
  preflight on this frozen contract at its immutable record.

## 18. Version-reset rule

Any change to the acceptance surface extracted here — any parent-referenced
schema, reason code, invariant, budget, phase boundary, or evidence rule —
requires a new file `contracts/automation/aut-wb-atomic-server.v2.md` with a
new freeze record and fresh reviewer preflight. The v1 file is never edited
in place after freeze. Parent-contract changes likewise reset this child to
v2; this child cannot amend the parent.

## 19. Freeze record

This file freezes at the commit that first introduces it on the
`docs/aut-wb-atomic-src-0` branch of `Olivaryne/openclaw-veelo`. The
immutable record is:

```text
contracts/automation/aut-wb-atomic-server.v1.md@<full-freeze-commit-sha>
```

The full freeze commit SHA is posted, with this path, on
[Olivaryne/openclaw-veelo#1](https://github.com/Olivaryne/openclaw-veelo/issues/1)
and [Olivaryne/veelo#392](https://github.com/Olivaryne/veelo/issues/392)
immediately after the freeze commit is pushed. Those issue comments, plus git
history, are the authoritative freeze evidence; the file body intentionally
cannot contain its own commit SHA.
