import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  validateGovernedScope,
  validateReceipt,
  validateTargetManifest,
  validateWorkflowText,
  verifyExactHead,
  writeReceiptArtifacts,
} from "./openclaw-ci.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "ci/openclaw/aut-wb-atomic-srv-1.json"), "utf8"),
);
const workflow = fs.readFileSync(
  path.join(root, ".github/workflows/openclaw-veelo-ci.yml"),
  "utf8",
);
const permittedFiles = [...manifest.permitted_files.production, ...manifest.permitted_files.tests];

function clone(value) {
  return structuredClone(value);
}

function validReceipt() {
  return {
    schema_version: "openclaw-ci-receipt/1",
    repository: "Olivaryne/openclaw-veelo",
    pull_request_number: 3,
    base_sha: "a".repeat(40),
    head_sha: "b".repeat(40),
    actual_checked_out_sha: "b".repeat(40),
    implementation_base_sha: manifest.implementation_base_sha,
    workflow_run_id: "12345",
    workflow_name: "OpenClaw Veelo Secret-Safe Verification",
    jobs: [
      { name: "workflow-and-scope-integrity", conclusion: "success" },
      { name: "workboard-focused-verification", conclusion: "success" },
      { name: "exact-rollback-fixture", conclusion: "success" },
      { name: "static-and-blast-radius-verification", conclusion: "success" },
    ],
    runner_image: "ubuntu-24.04",
    node_version: "v24.15.0",
    pnpm_version: "11.2.2",
    target_id: "AUT-WB-ATOMIC-SRV-1",
    parent_contract_reference:
      "Olivaryne/veelo:docs/architecture/aut-wb-atomic-create-or-recover-contract.md@4233aab48219f17f3a8d9ad7d2018c9fc95b93a6",
    child_contract_reference:
      "Olivaryne/openclaw-veelo:contracts/automation/aut-wb-atomic-server.v1.md@18ac73a0d31bc0dcf26294de72050af0b4031d29",
    rollback_package_version: "2026.7.1-2",
    rollback_registry_integrity: `sha512-${"A".repeat(86)}==`,
    rollback_local_artifact_digest: `sha256:${"c".repeat(64)}`,
    rollback_fixture_required: true,
    test_summaries: {
      focused: {
        conclusion: "success",
        commands: manifest.required_focused_commands,
      },
      rollback: {
        conclusion: "success",
        fixture_skipped: false,
        command:
          'node scripts/run-vitest.mjs extensions/workboard/src/sqlite-store.test.ts -t "2026.7.1-2 bundle"',
      },
      blast_radius: {
        conclusion: "success",
        commands: manifest.required_blast_radius_commands,
      },
    },
    final_conclusion: "success",
    prohibited_effects_confirmation: {
      actions_cache: false,
      aws_access: false,
      deployment: false,
      external_sends: false,
      gateway_access: false,
      live_migration: false,
      model_provider_calls: false,
      production_workboard_access: false,
      repository_writes: false,
      self_hosted_runner: false,
      slack_access: false,
      worker_start: false,
    },
  };
}

test("valid target manifest is closed and accepted", () => {
  assert.equal(validateTargetManifest(clone(manifest)).target_id, "AUT-WB-ATOMIC-SRV-1");
});

test("malformed target manifest fails closed", () => {
  const value = clone(manifest);
  value.parent_contract.commit_sha = "1234";
  assert.throws(() => validateTargetManifest(value), /full 40-character SHA/);
});

test("unknown target fields fail closed", () => {
  const value = clone(manifest);
  value.unreviewed = true;
  assert.throws(() => validateTargetManifest(value), /fields must be exactly/);
});

test("exact-head mismatch is rejected", () => {
  assert.throws(() => verifyExactHead("a".repeat(40), "b".repeat(40)), /exact-head mismatch/);
});

test("unauthorized governed file is rejected", () => {
  assert.throws(
    () => validateGovernedScope(manifest, [...permittedFiles, "extensions/workboard/src/extra.ts"]),
    /file budget mismatch/,
  );
});

test("dependency-file drift is rejected", () => {
  const files = [...permittedFiles.slice(0, -1), "package.json"];
  assert.throws(() => validateGovernedScope(manifest, files), /file budget mismatch/);
});

test("valid workflow passes the narrow static policy", () => {
  assert.ok(validateWorkflowText(workflow).action_count > 0);
});

const workflowMutations = [
  ["unpinned action", /actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v6", /full commit SHA/],
  [
    "third-party action",
    /actions\/checkout@[0-9a-f]{40}/,
    `evil/checkout@${"a".repeat(40)}`,
    /unauthorized action/,
  ],
  ["write permission", "contents: read", "contents: write", /write permissions/],
  ["pull_request_target", "pull_request:", "pull_request_target:", /pull_request_target/],
  ["self-hosted runner", "runs-on: ubuntu-24.04", "runs-on: self-hosted", /self-hosted/],
  ["secret expression", "CI: true", "CI: ${{ secrets.PRODUCTION_TOKEN }}", /secret expressions/],
  ["OIDC", "contents: read", "contents: read\n  id-token: write", /OIDC/],
  ["cache use", "package-manager-cache: false", "package-manager-cache: true", /cache use/],
  [
    "unsafe artifact",
    "${{ runner.temp }}/openclaw-ci-receipt/ci-receipt.json",
    "${{ runner.temp }}/openclaw-ci-receipt",
    /unsafe or missing artifact path/,
  ],
];

for (const [name, search, replacement, expected] of workflowMutations) {
  test(`${name} is rejected`, () => {
    const mutated = workflow.replace(search, replacement);
    assert.notEqual(mutated, workflow);
    assert.throws(() => validateWorkflowText(mutated), expected);
  });
}

test("valid receipt is accepted", () => {
  assert.equal(validateReceipt(validReceipt(), manifest).final_conclusion, "success");
});

test("malformed receipt with unknown fields is rejected", () => {
  const value = validReceipt();
  value.unreviewed = true;
  assert.throws(() => validateReceipt(value, manifest), /fields must be exactly/);
});

test("missing rollback evidence is rejected", () => {
  const value = validReceipt();
  value.rollback_fixture_required = false;
  assert.throws(() => validateReceipt(value, manifest), /missing rollback proof/);
});

test("rollback skip is rejected", () => {
  const value = validReceipt();
  value.test_summaries.rollback.fixture_skipped = true;
  assert.throws(() => validateReceipt(value, manifest), /rollback fixture skipped/);
});

test("mismatched rollback package version is rejected", () => {
  const value = validReceipt();
  value.rollback_package_version = "2026.7.1";
  assert.throws(() => validateReceipt(value, manifest), /version mismatch/);
});

test("invalid rollback integrity is rejected", () => {
  const value = validReceipt();
  value.rollback_registry_integrity = "sha512-not-valid";
  assert.throws(() => validateReceipt(value, manifest), /invalid rollback registry integrity/);
});

test("skipped mandatory job is rejected", () => {
  const value = validReceipt();
  value.jobs[2].conclusion = "skipped";
  assert.throws(() => validateReceipt(value, manifest), /did not succeed/);
});

test("unknown job conclusion is rejected", () => {
  const value = validReceipt();
  value.jobs[2].conclusion = "green";
  assert.throws(() => validateReceipt(value, manifest), /unknown job conclusion/);
});

test("target mismatch is rejected", () => {
  const value = validReceipt();
  value.target_id = "OTHER";
  assert.throws(() => validateReceipt(value, manifest), /target mismatch/);
});

test("malformed contract reference is rejected", () => {
  const value = validReceipt();
  value.parent_contract_reference = "main";
  assert.throws(() => validateReceipt(value, manifest), /contract reference mismatch/);
});

test("uppercase and short SHAs are rejected", () => {
  const uppercase = validReceipt();
  uppercase.head_sha = "B".repeat(40);
  assert.throws(() => validateReceipt(uppercase, manifest), /lowercase full 40-character SHA/);
  const short = validReceipt();
  short.base_sha = "a".repeat(12);
  assert.throws(() => validateReceipt(short, manifest), /lowercase full 40-character SHA/);
});

test("checked-out head mismatch is rejected", () => {
  const value = validReceipt();
  value.actual_checked_out_sha = "d".repeat(40);
  assert.throws(() => validateReceipt(value, manifest), /checked-out head mismatch/);
});

test("secret-shaped receipt values are rejected", () => {
  const value = validReceipt();
  value.workflow_name = ["ghp", "_", "a".repeat(26)].join("");
  assert.throws(() => validateReceipt(value, manifest), /secret-shaped/);
});

test("bounded test outputs contain no secret-shaped fixture values", () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-ci-test-"));
  try {
    const value = validReceipt();
    writeReceiptArtifacts(manifest, outputDir, {
      CI_REPOSITORY: value.repository,
      CI_PR_NUMBER: String(value.pull_request_number),
      CI_BASE_SHA: value.base_sha,
      CI_HEAD_SHA: value.head_sha,
      CI_ACTUAL_HEAD_SHA: value.actual_checked_out_sha,
      CI_WORKFLOW_RUN_ID: value.workflow_run_id,
      CI_WORKFLOW_NAME: value.workflow_name,
      CI_RUNNER_IMAGE: value.runner_image,
      CI_NODE_VERSION: value.node_version,
      CI_PNPM_VERSION: value.pnpm_version,
      CI_ROLLBACK_VERSION: value.rollback_package_version,
      CI_ROLLBACK_INTEGRITY: value.rollback_registry_integrity,
      CI_ROLLBACK_DIGEST: value.rollback_local_artifact_digest,
      CI_JOBS_JSON: JSON.stringify(value.jobs),
    });
    assert.deepEqual(fs.readdirSync(outputDir).toSorted(), [
      "ci-receipt.json",
      "rollback-package-integrity.txt",
      "test-summary.txt",
    ]);
    const rendered = fs
      .readdirSync(outputDir)
      .map((file) => fs.readFileSync(path.join(outputDir, file), "utf8"))
      .join("\n");
    assert.doesNotMatch(rendered, /github_pat_|gh[pousr]_|AKIA|PRIVATE KEY|xox[baprs]-/);
  } finally {
    fs.rmSync(outputDir, { recursive: true });
  }
});
