# Veelo-owned OpenClaw source authority: provenance and maintenance policy

Status: **governance document — SRC-0 repository bootstrap. Documentation
only; authorizes no implementation.**

- Repository: `Olivaryne/openclaw-veelo`
- Veelo program issue: [Olivaryne/veelo#380](https://github.com/Olivaryne/veelo/issues/380)
- AUT-WB-ATOMIC issue: [Olivaryne/veelo#392](https://github.com/Olivaryne/veelo/issues/392)
- Governed implementation issue: [Olivaryne/openclaw-veelo#1](https://github.com/Olivaryne/openclaw-veelo/issues/1)

## 1. Upstream provenance

| Item | Value |
| --- | --- |
| Upstream repository | `openclaw/openclaw` (`https://github.com/openclaw/openclaw.git`) |
| Upstream visibility | public, unarchived |
| Upstream default branch | `main` |
| Upstream base commit | `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` (`fix(plugins): accept singleton npm view metadata`, committed 2026-07-18T03:31:18Z) |
| Fork method | GitHub fork of `openclaw/openclaw`, complete source history preserved, upstream network relationship retained |
| Veelo default branch | `veelo-main`, created at exactly the upstream base commit above |
| Remote layout | `origin` = `https://github.com/Olivaryne/openclaw-veelo.git`; `upstream` = `https://github.com/openclaw/openclaw.git` |

### Repository visibility

This repository is currently **public**. Visibility is an operator-managed
GitHub setting, not a contract assumption: no governance document, contract,
or procedure in this repository may depend on the repository being public or
private, and the operator may change visibility at any time without a
contract-version reset. The MIT obligations in section 2 hold under either
setting.

### Relationship to the installed npm deployment

The production host runs npm package `openclaw 2026.7.1-2`. That release
publishes no `gitHead` and upstream has no `v2026.7.1-2` tag. Lineage is
anchored as follows, so the full commit SHA — not a tag — is the provenance
anchor:

- the installed binary self-reports `OpenClaw 2026.7.1-2 (0790d9f)`;
- installed package metadata reports version `2026.7.1-2` and repository
  `openclaw/openclaw`;
- at `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`, `CHANGELOG.md` introduces the
  `2026.7.1-2` entry while `package.json` remains `2026.7.1`.

The installed npm tree is compiled distribution material containing no
`extensions/workboard/src/*.ts`. It is evidence and rollback input only. It is
never a source of edits and is never imported into this repository.

### Required source files verified at the base commit

`extensions/workboard/src/`: `types.ts`, `sqlite-store.ts`, `store.ts`,
`gateway.ts`, and their test peers (`store.test.ts`, `sqlite-store-policy.test.ts`,
`gateway.test.ts`, `cli.test.ts`, `command.test.ts`, `dispatcher.test.ts`,
`tools.test.ts`).

## 2. License and attribution

Upstream is MIT-licensed (`LICENSE`, Copyright (c) 2026 OpenClaw Foundation),
with incorporated-code notices in `THIRD_PARTY_NOTICES.md`. The MIT license
expressly permits copying, modification, distribution, and sublicensing
provided the copyright and permission notice are retained.

- This fork retains upstream `LICENSE` and `THIRD_PARTY_NOTICES.md` unmodified
  in full history. They must never be removed or rewritten.
- Veelo-added material (this document, `contracts/`) is governance
  documentation owned by Veelo and does not alter upstream licensing.
- A public GitHub fork satisfies MIT redistribution conditions; no additional
  permission from upstream is required for private-use builds or maintained
  divergence.

## 3. Branch and synchronization policy

- `veelo-main` — the Veelo-controlled delivery branch and repository default.
  Nothing lands here except reviewed pull requests. Its base is pinned at the
  upstream commit above; every Veelo change is an explicit reviewed commit on
  top of that base.
- `main` — untouched mirror of upstream `main`. Fast-forward only, never a
  merge target for Veelo work, never contains Veelo commits.

Synchronization procedure (operator-authorized, never automatic):

1. `git fetch upstream`
2. Fast-forward local/origin `main` to `upstream/main`.
3. Rebase or merge `veelo-main` onto the new upstream baseline only as a
   reviewed pull request, with the full Workboard test suite run at the
   candidate head and the new upstream base SHA recorded in the PR body.
4. Any upstream change touching `extensions/workboard/` is called out
   explicitly in that PR for re-review against the frozen contracts.

## 4. Supported upstream version policy

- Exactly one supported baseline at a time; currently
  `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` (= installed `2026.7.1-2`
  lineage).
- Advancing the baseline is an operator decision executed via the
  synchronization procedure above, and requires re-running the rollback
  compatibility fixture (parent contract §6.5) against whatever binary is then
  installed before any deployment.
- No implementation work may target an unsupported or floating baseline.

## 5. Delivery rules

1. **Never edit installed `dist`.** Patching installed compiled bundles
   (`node_modules/openclaw/dist/*`) is prohibited in all circumstances. All
   changes are made in TypeScript source in this repository.
2. **Reviewed source builds only.** Anything deployed to a Veelo host must be
   built from a reviewed commit on `veelo-main`, identified by full commit
   SHA.
3. **Deployment receipts.** Every deployment of an artifact built from this
   repository must record: source commit SHA, build command, artifact digest,
   target host, timestamp, and the authorizing operator decision. No receipt,
   no deployment.
4. **Rollback evidence.** No deployment without recorded rollback evidence:
   the exact-version rollback compatibility fixture for the currently
   supported baseline (section 4) is run at the deployed source commit, and
   its result is referenced from the deployment receipt.
5. **No secrets, no machine state.** This repository never contains secrets,
   tokens, machine-specific configuration, live database state, or copied
   compiled npm bundles.
6. **Governed holds.** PRs implementing governed contracts carry `hold` and
   `operator-merge-only`; only the operator merges them.

## 6. Frozen governance documents

| Document | Purpose |
| --- | --- |
| `contracts/automation/aut-wb-atomic-server.v1.md` | Immutable server child contract for AUT-WB-ATOMIC-SRV-1 (see its freeze record) |
| `contracts/automation/aut-wb-atomic-a01-a46-ownership-map.v1.md` | Proposed phase-ownership map for the 46 parent acceptance rows |

Frozen contract files are never edited in place. Any acceptance-surface change
requires a new version file (v2) and a new freeze record.
