# AUT-WB-ATOMIC A01–A46 proposed phase-ownership map v1

Status: **ownership proposal only. No row is marked passing. Authorizes no
implementation.**

Parent rows: frozen adversarial acceptance matrix, parent contract §7
(`docs/architecture/aut-wb-atomic-create-or-recover-contract.md@4233aab48219f17f3a8d9ad7d2018c9fc95b93a6`,
`Olivaryne/veelo`). Child contract:
`contracts/automation/aut-wb-atomic-server.v1.md` (this repository).

Owning phases (each row has exactly one formal owner — the phase that must
close the complete acceptance row):

- **SRV** — Server primitive PR, repository `Olivaryne/openclaw-veelo`
  (branch `feat/aut-wb-atomic-srv-1`).
- **COMPAT** — AUT-002 compatibility PR, repository `Olivaryne/veelo`
  (after server release; parent §3.6).
- **BIND** — Production binding/canary PR, repository `Olivaryne/veelo`
  against the released OpenClaw gateway/SQLite fixture (after both prior
  merges; parent §8.2 closing paragraph).

Earlier server-side sub-proofs consumed by a later phase do not create
duplicate ownership; cross-boundary rows name the final-integration-evidence
owner in the Reason column.

| ID | Short purpose | Owner | Required repository | Evidence type | Dependency | Reason it belongs in that phase |
| --- | --- | --- | --- | --- | --- | --- |
| A01 | Two OS processes, same new key → one create, one recover | SRV | openclaw-veelo | Real child-process race transcript against one SQLite file; two receipts, one card ID | Schema-3 migration (A34 machinery) | Pure store/SQLite authority; no caller involved. |
| A02 | 16 concurrent same-key calls → exactly one create | SRV | openclaw-veelo | Barrier-start 16-client stress, repeated 10x; 16 receipts, one card | A01 harness | Same server-only concurrency authority at higher fan-out. |
| A03 | Different keys create independently | SRV | openclaw-veelo | Two-key interleaving race; receipts grouped by key | A01 harness | Index-scoped independence is a store property. |
| A04 | Response lost after commit; same-key retry recovers | BIND | veelo (against released OpenClaw fixture) | Fault-injected transport drop; caller receipt + resolvable create/recovery receipts | SRV committed-create recovery sub-proof; COMPAT caller receipts | Full row needs real transport loss and caller-receipt closure, which only exist at binding. SRV supplies the server sub-proof (committed create recoverable by same key); BIND owns final integration evidence. |
| A05 | Crash before commit rolls back | SRV | openclaw-veelo | Deterministic kill before COMMIT; retry creates; no first receipt | A01 harness | Transaction atomicity is SQLite-boundary behavior. |
| A06 | Crash after commit, before response | SRV | openclaw-veelo | Deterministic post-COMMIT kill; retry recovers; create receipt survives restart | A05 harness | Commit-then-recover is server durability, caller-independent. |
| A07 | Service restart then same key/spec recovers | SRV | openclaw-veelo | Close/reopen real DB; recovery receipt after reopen | A01 | Store restart semantics only. |
| A08 | Same key, identical spec → recovered, no mutation | SRV | openclaw-veelo | Before/after card row and child-row digests; recovery receipt | — | Core recover path in `store.ts`. |
| A09 | Changed risk class → conflict | SRV | openclaw-veelo | Conflict receipt with two fingerprints; row digest unchanged | A08 | Fingerprint conflict decision is server-owned. |
| A10 | Changed approval policy → conflict | SRV | openclaw-veelo | Conflict receipt; unchanged row digest | A08 | Same server conflict authority. |
| A11 | Changed skill name/version → conflict | SRV | openclaw-veelo | Conflict receipt; unchanged row digest | A08 | Same server conflict authority. |
| A12 | Changed output contract ref → conflict | SRV | openclaw-veelo | Conflict receipt; unchanged row digest | A08 | Same server conflict authority. |
| A13 | Changed verification contract ref → conflict | SRV | openclaw-veelo | Conflict receipt; unchanged row digest | A08 | Same server conflict authority. |
| A14 | Changed derived title → request-invalid | SRV | openclaw-veelo | Validator test; evidence `null`; no lookup performed | — | Validation-before-lookup lives in the server validator. |
| A15 | Changed status/priority/execution control → request-invalid | SRV | openclaw-veelo | Validator tests per fixed field | — | Fixed-field enforcement is server validation. |
| A16 | Changed labels → request-invalid | SRV | openclaw-veelo | Three label-mutation validator tests | — | Same. |
| A17 | Changed notes → request-invalid | SRV | openclaw-veelo | Notes-derivation validator test | — | Same. |
| A18 | Changed automation ID under same key → request-invalid | SRV | openclaw-veelo | Exact AUT-001 key-vector mismatch test | — | Occurrence-key derivation check is server validation. |
| A19 | Changed schedule revision under same key → request-invalid | SRV | openclaw-veelo | Key-vector mismatch test | A18 harness | Same derivation authority. |
| A20 | Changed scheduled instant under same key → request-invalid | SRV | openclaw-veelo | Key-vector mismatch test | A18 harness | Same derivation authority. |
| A21 | Changed board/lane/template → conflict | SRV | openclaw-veelo | Conflict receipt; original board/state digest | A08 | Board identity conflicts are server fingerprint scope. |
| A22 | Missing/unknown request field → request-invalid | SRV | openclaw-veelo | Table-driven schema tests at every level | — | Closed-schema enforcement is the server validator. |
| A23 | Malformed stored correlation metadata → stored-record-invalid | SRV | openclaw-veelo | Corrupt-each-field fixtures; stored-invalid receipt | Schema-3 columns | Hydration validation is store-owned. |
| A24 | Forged fingerprint → stored-record-invalid | SRV | openclaw-veelo | Both forged variants; stored-invalid receipt | A23 harness | Fingerprint verification is server authority. |
| A25 | Unknown stored governance field → stored-record-invalid | SRV | openclaw-veelo | Nested/top-level unknown-field fixtures | A23 harness | Canonical parser is server-owned. |
| A26 | Existing assigned card → state-incompatible | SRV | openclaw-veelo | State-refusal receipt; assignment untouched | A08 | Pristine-state validator is server-owned. |
| A27 | Existing claimed card → state-incompatible | SRV | openclaw-veelo | State-refusal receipt, no token exposure | A26 harness | Same. |
| A28 | Existing running card → state-incompatible | SRV | openclaw-veelo | Per-running-signal refusal tests | A26 harness | Same. |
| A29 | Existing terminal card → state-incompatible | SRV | openclaw-veelo | Done/completed/archived variants | A26 harness | Same. |
| A30 | Foreign/indexed/legacy card under key → typed refusal | SRV | openclaw-veelo | Indexed-malformed and legacy variants; bounded refusal receipt | Schema-3 + legacy detector | Legacy fail-closed posture (parent §6.3) is store logic. |
| A31 | Store unavailable → typed unavailable, no fallback | BIND | veelo (against released fixture) | ENOENT/EACCES/connection-refused injection; caller receipt; no fallback path | SRV gateway classification sub-proof; COMPAT adapter mapping | Full row closes over adapter mapping and caller receipt, which exist only at binding. SRV supplies correct typed classification and no-fallback sub-proof; BIND owns final integration evidence. |
| A32 | Corrupt store / unreadable row → row-scoped invalid or unavailable | SRV | openclaw-veelo | Corrupt-DB and corrupt-row fixtures | A23 | Trust classification of the store is server-owned. |
| A33 | Confirmed storage failure → rollback, zero cards | SRV | openclaw-veelo | Injected INSERT/fsync/COMMIT failures; full-rollback digests; no server receipt | A05 harness | Rollback confirmation is SQLite-boundary behavior. |
| A34 | Transactional schema-3 migration interruption | SRV | openclaw-veelo | Deterministic kills at DDL/index/ledger stages; ledger verification | — | Migration mechanism ships in `sqlite-store.ts`. |
| A35 | Exact-version rollback after migration | SRV | openclaw-veelo | Temporary-fixture transcript/digests against exact installed `2026.7.1-2` bundle lineage | A34 | Child contract §14 rollback evidence; server-side compatibility proof. |
| A36 | Malformed/forged response rejected locally | COMPAT | veelo | Table-driven closed response parser tests; caller receipt | Released server envelope (SRV) | The rejecting parser is the Veelo adapter validator; server only supplies exact envelopes to test against. |
| A37 | No execution surface reachable | SRV | openclaw-veelo | Static import-graph scan + throwing dynamic spies, all zero | — | Reachability of dispatch/claim/start/model/send/timer is a property of the server method/gateway modules. |
| A38 | AUT-001 definition maps without hidden authority | COMPAT | veelo | Byte-for-byte v1 spec construction vector; registry/env/default spies throw | Frozen v1 spec (SRV types) | Pure `materializer.cjs` construction; no server involvement. |
| A39 | AUT-002 exact-v1 response round trip via reference adapters | COMPAT | veelo | End-to-end reference-adapter created and recovered cases; caller receipt copies server receipt ref | SRV release; A38 | Reference-adapter round trip is Veelo compatibility scope by parent §3.6. |
| A40 | Old compact AUT-002 adapter rejected | COMPAT | veelo | Old-version/old-spec/compact-response/synthetic-projection cases → `workboard_result_invalid` | A39 validator | Version-gate and closed validator live in the Veelo adapter. |
| A41 | Cross-repository fingerprint conformance | COMPAT | veelo (final closure) + vectors in openclaw-veelo | Shared frozen positive and one-byte-negative vectors passing in both repositories | SRV vector half committed first | Row closes only when the independent Veelo implementation matches the OpenClaw vectors; SRV ships its half, COMPAT owns final cross-repository integration evidence. |
| A42 | Protected tuple update/clear/rebind refused | SRV | openclaw-veelo | Per-column constraint-refusal tests + row digests | Schema-3 triggers (A34) | SQLite trigger authority. |
| A43 | Generic create/upsert preserves authority tuple | SRV | openclaw-veelo | Current and exact-old-binary generic register fixtures; before/after tuple digests | A35 fixture | Store-level preservation guarantee. |
| A44 | Normal delete archives; direct delete refused | SRV | openclaw-veelo | Normal delete, direct delete, uncorrelated control; archive event + digests | Schema-3 triggers | Store + gateway + trigger behavior, caller-independent. |
| A45 | Archived key cannot be reused | SRV | openclaw-veelo | Restart-then-reuse attempts; same card ID in refusal receipt | A44 | Key-lifetime authority is server-owned. |
| A46 | Real definition → transport → gateway → AUT-002 validation | BIND | veelo (against released OpenClaw gateway/SQLite fixture) | Real cross-boundary integration run with registry/env/default/fabrication spies throwing; server receipt preserved in caller receipt | SRV release; COMPAT merge | The only row exercising real transport plus both validation layers; it is the binding phase's existence proof and BIND owns final integration evidence. |

## Audit

- SRV formal owners (38): A01–A03, A05–A30, A32–A35, A37, A42–A45.
- COMPAT formal owners (5): A36, A38–A41.
- BIND formal owners (3): A04, A31, A46.
- Audit arithmetic: SRV 38 (3 + 26 + 4 + 1 + 4) + COMPAT 5 + BIND 3 = 46.
- Unassigned rows: none. Duplicate owners: none. Total: 46.
- Parent-contract change required: none.
- Cross-boundary rows and their final-integration-evidence owners: A04 →
  BIND; A31 → BIND; A41 → COMPAT; A46 → BIND. Server sub-proofs for these
  rows are produced in the SRV PR without claiming row closure.
- Later phases do not repeat or replace server authority: COMPAT and BIND
  consume the released server primitive and its receipts; they re-verify
  envelopes locally but own no server-side decision, transaction, or schema
  behavior.

No row is marked passing anywhere in this document.
