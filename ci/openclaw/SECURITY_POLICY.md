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
- Contracts: the private parent contract is verified through the closed
  digest attestation in `ci/openclaw/attestations/aut-wb-parent-contract.v1.json`
  read from the trusted base checkout; every attestation identity and digest
  field must equal the target manifest authority exactly. The child contract
  is read from its immutable commit in the source repository history and its
  byte digest must match the target manifest. CI never checks out any
  repository other than this one and the PR source repository.
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
Every `actions/checkout` invocation may target only the PR source repository
or this repository; any other `repository:` value fails validation.

## Private parent-contract attestation

The parent contract lives in the private repository `Olivaryne/veelo`, which
is not accessible to the repository-scoped CI token of this public repository
(CI-OPENCLAW-001 canary run `30268966243` failed on exactly that checkout).
The CI lane does not receive cross-repository credentials of any kind: no
PAT, no repository or environment secret, no GitHub App key, no OIDC. The
parent contract remains authoritative at its frozen private source reference;
this public repository stores only a closed digest attestation, and the
private contract bytes are never published here.

The lane verifies the parent through
`ci/openclaw/attestations/aut-wb-parent-contract.v1.json`, a closed JSON
object holding only provenance identifiers and content commitments: source
repository, immutable commit, path, Git blob SHA, and file SHA-256. It was
produced by an operator-authenticated read of the exact private source
outside CI, embeds no contract content, and carries no cryptographic
signature — it claims none (`authority_kind: digest-attestation`).

Trust argument and limits:

- The attestation is not an independent authority. Every identity and digest
  field it shares with the manifest must equal
  `ci/openclaw/aut-wb-atomic-srv-1.json` exactly, so a tampered attestation
  cannot retarget the parent contract without also defeating the reviewed
  manifest. The Git blob SHA adds a second, independently checkable
  commitment to the same bytes.
- Both files are read from the trusted PR base checkout, so a pull request
  cannot substitute its own attestation or manifest for the governed checks.
- The closed field set, pinned field values, and secret-pattern scan mean the
  attestation cannot smuggle private contract content or credentials: every
  free-form field is pinned to an exact reviewed value or a fixed-length hex
  digest.
- Unlike the original design, the workflow does not independently read the
  private contract on each run; byte-level verification of the parent
  happened once, outside CI, under operator authentication. Anyone with read
  access to `Olivaryne/veelo` can independently re-verify the attestation by
  hashing `docs/architecture/aut-wb-atomic-create-or-recover-contract.md` at
  commit `4233aab48219f17f3a8d9ad7d2018c9fc95b93a6`. The child contract is
  still byte-verified by CI on every run from the public source history.
- Before any change carrying a new or modified attestation is merged, an
  operator-authenticated independent review must verify the attestation
  against the private source: repository, commit, path, Git blob SHA, and
  SHA-256, without posting the contract contents.
- A future parent-contract change requires a new immutable source commit,
  new digests, a new attestation version, and a fresh independent review.
  The attestation cannot be updated in place by CI or by any pull request
  acting alone: the governed checks read it from the trusted base checkout
  only.

## Workflow jobs

1. `workflow-and-scope-integrity` verifies exact checkout identity,
   base/head ancestry, workflow policy, closed target shape, the closed
   parent-contract attestation, exact file scope, dependency immutability,
   child contract bytes, and added-line secret patterns.
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
allowlist, exact checkout fragments, checkout-repository confinement,
credential-shaped environment-name rejection, trusted attestation-path
confinement, job timeouts, and prohibited patterns. `actionlint`, `zizmor`,
and independent security review of the parsed GitHub Actions meaning remain
the compensating controls for full YAML semantics.

Actions are enabled for this repository under the restricted allowlist above.
Local validation and an independent review do not constitute a GitHub Actions
run.
