# CI-OPENCLAW-001 security policy

This policy owns the secret-safe GitHub-hosted verification lane for governed
OpenClaw changes. The lane is evidence-only. It does not authorize merge,
installation, live migration, deployment, activation, dispatch, worker start,
model/provider access, production Workboard access, or external sends.

## Trust boundary

- Trigger: `pull_request` into `veelo-main`, limited to `opened`,
  `synchronize`, `reopened`, and `ready_for_review`.
- Authority: top-level `permissions: contents: read`; no job adds permissions.
- Runner: GitHub-hosted `ubuntu-24.04` only, with an explicit timeout on every
  job and PR-scoped `cancel-in-progress` concurrency.
- Source: the PR source repository and exact `pull_request.head.sha` are
  checked out with full history and `persist-credentials: false`.
- Tooling: validators and receipt generation execute from the exact trusted
  PR base checkout, not from the untrusted PR source checkout.
- Contracts: the external parent contract is checked out at its immutable
  commit; the child contract is read from its immutable commit in the source
  repository history. Both byte digests must match the target manifest.
- Dependencies: Corepack resolves the lockfile-pinned pnpm version. No Actions
  cache is used. Target jobs run only after the governed identity, ancestry,
  seven-file budget, dependency immutability, and contract checks pass.

Generic pull requests run only the workflow/security and exact-head baseline.
They cannot claim `AUT-WB-ATOMIC-SRV-1` completion. The focused, rollback, blast
radius, and receipt jobs are gated on the closed target identity in
`ci/openclaw/aut-wb-atomic-srv-1.json`.

## Pinned action allowlist

Only GitHub-authored actions are allowed. Every reference is a full commit SHA.

| Action          | Source repository         | Full SHA                                   | Release reference |
| --------------- | ------------------------- | ------------------------------------------ | ----------------- |
| Checkout        | `actions/checkout`        | `de0fac2e4500dabe0009e67214ff5f5447ce83dd` | `v6.0.2`          |
| Setup Node      | `actions/setup-node`      | `53b83947a5a98c8d113130e565377fae1a50d02f` | `v6.3.0`          |
| Upload artifact | `actions/upload-artifact` | `bbbca2ddaa5d8feaa63e36b76fdaad77386f024f` | `v7.0.0`          |

Moving tags, local actions, third-party actions, cache actions, reusable
privileged workflows, and any action outside this table fail validation.

## Workflow jobs

1. `workflow-and-scope-integrity` verifies exact checkout identity,
   base/head ancestry, workflow policy, closed target shape, exact file scope,
   dependency immutability, contract bytes, and added-line secret patterns.
2. `workboard-focused-verification` installs from the frozen lockfile and runs
   the complete Workboard suite, including the current real-process,
   crash/restart, migration, tamper/refusal, legacy-authority, canonical-byte,
   receipt, and bounded regression probes.
3. `exact-rollback-fixture` resolves only `openclaw@2026.7.1-2` from the public
   npm registry, compares the downloaded tarball against registry SRI,
   deterministically resolves the one packaged SQLite store bundle, and runs
   the mandatory rollback fixture with skip refusal enabled.
4. `static-and-blast-radius-verification` runs all three applicable typecheck
   lanes, full build, exact-file lint and format, import-cycle validation,
   the eight Workboard-referencing regression files, and a base/head
   dependency-audit comparison.
5. `bounded-receipt` generates and validates the closed
   `openclaw-ci-receipt/1` receipt, then uploads only `ci-receipt.json`,
   `test-summary.txt`, and `rollback-package-integrity.txt` for seven days.

The workflow does not describe an unavailable broader upstream suite as green.

## Prohibited capabilities and outputs

The lane has no self-hosted runner, `pull_request_target`, OIDC, write
permission, repository/environment secret expression, write token, Actions
cache, privileged follow-up, workflow commit/comment, release, deployment,
production host, production Workboard, Slack, AWS, gateway, provider/model,
installation, live migration, activation, dispatch, worker-start, or external
send capability.

Artifacts are a closed three-file allowlist. Raw logs, databases, home
directories, `.npmrc`, Git configuration, credentials, package-manager auth,
and production data are never artifact inputs.

## Validator limits

`scripts/ci/openclaw-ci.mjs` intentionally uses only Node core modules. Its
workflow check is a narrow static policy validator, not a complete YAML
semantic proof. It verifies required high-risk invariants, a closed action
allowlist, exact checkout fragments, job timeouts, and prohibited patterns.
Independent security review must additionally inspect the parsed GitHub Actions
meaning before Actions are enabled.

Actions are currently disabled for this repository. Local validation and an
independent review do not constitute a GitHub Actions run.
