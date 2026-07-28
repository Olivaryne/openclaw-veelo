import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  extractPackageTree,
  inspectPackageArchive,
  readParentAttestation,
  scanLinesForDisclosure,
  validateGovernedScope,
  validateParentAttestation,
  validateReceipt,
  validateTargetManifest,
  validateWorkflowText,
  verifyContractReferences,
  verifyExactHead,
  verifyExtractedTree,
  verifyPullRequest,
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
const attestation = JSON.parse(
  fs.readFileSync(
    path.join(root, "ci/openclaw/attestations/aut-wb-parent-contract.v1.json"),
    "utf8",
  ),
);
const permittedFiles = [...manifest.permitted_files.production, ...manifest.permitted_files.tests];

function clone(value) {
  return structuredClone(value);
}

function validReceipt() {
  return {
    schema_version: "openclaw-ci-receipt/1",
    repository: "Olivaryne/openclaw-veelo",
    pull_request_number: 7,
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

test("governed target is rebound to replacement PR #7 with everything else preserved", () => {
  // CI-OPENCLAW-002: superseded canary PR #3 (feat/aut-wb-atomic-srv-1) is
  // replaced by PR #7 on its proof branch; every other governed identity
  // field stays frozen.
  assert.equal(manifest.repository, "Olivaryne/openclaw-veelo");
  assert.equal(manifest.pull_request_number, 7);
  assert.equal(manifest.base_branch, "veelo-main");
  assert.equal(manifest.implementation_branch, "proof/aut-wb-atomic-srv-1-a22-a25");
  assert.equal(manifest.implementation_base_sha, "ff2131e587645d473d3328831e42a50e3529ed38");
  assert.equal(manifest.rollback_package.version, "2026.7.1-2");
  assert.equal(permittedFiles.length, 7);
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

test("workflow drift is rejected", () => {
  const files = [...permittedFiles.slice(0, -1), ".github/workflows/openclaw-veelo-ci.yml"];
  assert.throws(() => validateGovernedScope(manifest, files), /file budget mismatch/);
});

test("deployment-file drift is rejected", () => {
  const files = [...permittedFiles.slice(0, -1), "deploy/production.yaml"];
  assert.throws(() => validateGovernedScope(manifest, files), /file budget mismatch/);
});

// Synthetic PR history for governed classification: an implementation-base
// commit, a seven-file implementation commit, and an A22/A25-style proof
// commit that stays inside the already-governed store.test.ts path. The
// fixture manifest pins implementation_base_sha to the fixture base so the
// real merge-base rules are exercised against real git history.
function makeGovernedPrRepo({ omitFile, extraFile } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-governed-pr-")));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  run(["init", "-q"]);
  for (const file of permittedFiles) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), `// ${file} base fixture\n`);
  }
  fs.writeFileSync(path.join(dir, "README.md"), "governed PR fixture\n");
  run(["add", "."]);
  run(["commit", "-qm", "implementation base fixture"]);
  const baseSha = run(["rev-parse", "HEAD"]).trim();
  for (const file of permittedFiles) {
    if (file !== omitFile) {
      fs.appendFileSync(path.join(dir, file), "// implementation fixture change\n");
    }
  }
  if (extraFile) {
    fs.mkdirSync(path.dirname(path.join(dir, extraFile)), { recursive: true });
    fs.writeFileSync(path.join(dir, extraFile), "// out-of-budget fixture file\n");
  }
  run(["add", "."]);
  run(["commit", "-qm", "implementation fixture"]);
  fs.appendFileSync(
    path.join(dir, "extensions/workboard/src/store.test.ts"),
    "// A22/A25 proof fixture change\n",
  );
  run(["add", "."]);
  run(["commit", "-qm", "A22/A25 proof fixture"]);
  const headSha = run(["rev-parse", "HEAD"]).trim();
  const fixtureManifest = clone(manifest);
  fixtureManifest.implementation_base_sha = baseSha;
  return { dir, baseSha, headSha, fixtureManifest };
}

function verifyFixturePullRequest(fixture, overrides = {}) {
  return verifyPullRequest({
    sourceDir: fixture.dir,
    manifest: fixture.fixtureManifest,
    repository: manifest.repository,
    prNumber: manifest.pull_request_number,
    baseBranch: manifest.base_branch,
    headBranch: manifest.implementation_branch,
    eventBaseSha: fixture.baseSha,
    expectedHeadSha: fixture.headSha,
    ...overrides,
  });
}

test("replacement PR #7 on its exact branch is governed", () => {
  const fixture = makeGovernedPrRepo();
  try {
    const result = verifyFixturePullRequest(fixture);
    assert.equal(result.governed, true);
    assert.equal(result.pull_request_number, 7);
    assert.equal(result.actual_checked_out_sha, fixture.headSha);
    assert.equal(result.merge_base_sha, fixture.baseSha);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("PR #7 on the wrong branch is generic, never governed", () => {
  const fixture = makeGovernedPrRepo();
  try {
    const result = verifyFixturePullRequest(fixture, { headBranch: "feat/aut-wb-atomic-srv-1" });
    assert.equal(result.governed, false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("superseded canary PR #3 is no longer governed", () => {
  const fixture = makeGovernedPrRepo();
  try {
    const oldTarget = verifyFixturePullRequest(fixture, {
      prNumber: 3,
      headBranch: "feat/aut-wb-atomic-srv-1",
    });
    assert.equal(oldTarget.governed, false);
    const oldNumberOnly = verifyFixturePullRequest(fixture, { prNumber: 3 });
    assert.equal(oldNumberOnly.governed, false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("wrong PR number is not governed", () => {
  const fixture = makeGovernedPrRepo();
  try {
    assert.equal(verifyFixturePullRequest(fixture, { prNumber: 8 }).governed, false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("wrong repository is not governed", () => {
  const fixture = makeGovernedPrRepo();
  try {
    const result = verifyFixturePullRequest(fixture, { repository: "Olivaryne/veelo" });
    assert.equal(result.governed, false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("governed PR with the wrong implementation base refuses", () => {
  const fixture = makeGovernedPrRepo();
  try {
    fixture.fixtureManifest.implementation_base_sha = "f".repeat(40);
    assert.throws(() => verifyFixturePullRequest(fixture), /does not equal implementation base/);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("governed PR with an extra changed file refuses", () => {
  const fixture = makeGovernedPrRepo({ extraFile: "extensions/workboard/src/extra-helper.ts" });
  try {
    assert.throws(() => verifyFixturePullRequest(fixture), /file budget mismatch/);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("governed PR missing a governed file refuses", () => {
  const fixture = makeGovernedPrRepo({ omitFile: "extensions/workboard/src/gateway.ts" });
  try {
    assert.throws(() => verifyFixturePullRequest(fixture), /file budget mismatch/);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
});

test("A22/A25 proof changes in governed store.test.ts stay within the seven-file budget", () => {
  const fixture = makeGovernedPrRepo();
  try {
    const result = verifyFixturePullRequest(fixture);
    assert.equal(result.governed, true);
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", `${fixture.baseSha}...${fixture.headSha}`],
      { cwd: fixture.dir, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    const byPath = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
    assert.deepEqual(changed.toSorted(byPath), [...permittedFiles].toSorted(byPath));
  } finally {
    fs.rmSync(fixture.dir, { recursive: true });
  }
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
  [
    "cross-repository private checkout",
    "repository: ${{ github.repository }}",
    "repository: Olivaryne/veelo",
    /cross-repository checkout is prohibited/,
  ],
  [
    "missing attestation validation",
    "validate-attestation",
    "validate-nothing",
    /missing required fragment: validate-attestation/,
  ],
  [
    "secret-based private checkout",
    "persist-credentials: false",
    "token: ${{ secrets.VEELO_PAT }}",
    /secret expressions/,
  ],
  [
    "GitHub App token-generation action",
    /actions\/checkout@[0-9a-f]{40}/,
    `actions/create-github-app-token@${"a".repeat(40)}`,
    /unauthorized action/,
  ],
  [
    "cross-repository gh api fetch",
    "corepack enable",
    "gh api repos/Olivaryne/veelo/contents/docs",
    /prohibited external-effect command/,
  ],
  [
    "curl fetch",
    "corepack enable",
    "curl -s https://example.com/private",
    /prohibited external-effect command/,
  ],
  [
    "PAT-shaped environment name",
    "CI: true",
    "GH_PAT: placeholder",
    /credential-shaped environment name/,
  ],
  [
    "attestation from the untrusted source checkout",
    "--parent-attestation trusted/ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
    "--parent-attestation source/ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
    /trusted attestation directory/,
  ],
];

for (const [name, search, replacement, expected] of workflowMutations) {
  test(`${name} is rejected`, () => {
    const mutated = workflow.replace(search, replacement);
    assert.notEqual(mutated, workflow);
    assert.throws(() => validateWorkflowText(mutated), expected);
  });
}

const credentialEnvNames = [
  "APP_PRIVATE_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "PRIVATE_KEY",
  "SSH_PRIVATE_KEY",
  "SIGNING_PRIVATE_KEY",
  "APP_PRIVATEKEY",
  "PRIVATEKEY",
  "app_private_key",
  "API_TOKEN",
  "CLIENT_SECRET",
  "DB_PASSWORD",
  "APP_CREDENTIAL",
  "GITHUB_PAT",
];

for (const envName of credentialEnvNames) {
  test(`credential-shaped environment name ${envName} is rejected`, () => {
    const mutated = workflow.replace("CI: true", `${envName}: placeholder`);
    assert.notEqual(mutated, workflow);
    assert.throws(() => validateWorkflowText(mutated), /credential-shaped environment name/);
  });
}

const benignEnvNames = [
  "CORRELATION_KEY",
  "IDEMPOTENCY_KEY",
  "PUBLIC_KEY_ID",
  "MONKEY",
  "KEYSTONE_MODE",
  "CACHE_KEY",
];

for (const envName of benignEnvNames) {
  test(`benign environment name ${envName} is not rejected`, () => {
    const mutated = workflow.replace("CI: true", `${envName}: fixture-value`);
    assert.notEqual(mutated, workflow);
    assert.ok(validateWorkflowText(mutated).action_count > 0);
  });
}

test("checked-in parent attestation yields the bounded trusted-digest evidence", () => {
  assert.deepEqual(validateParentAttestation(clone(attestation), manifest), {
    parent_reference:
      "Olivaryne/veelo:docs/architecture/aut-wb-atomic-create-or-recover-contract.md@4233aab48219f17f3a8d9ad7d2018c9fc95b93a6",
    source_git_blob_sha: "f3b58cd7f807ce1e3773c41b7601e04a52a8a064",
    source_sha256: "c3680fa42c1df3cd156cc57a44230c2cb3f3628a3670d1b2774cc2804c9654e4",
    verification_mode: "trusted-digest-attestation",
  });
});

const attestationMutations = [
  {
    name: "unknown or content-bearing field",
    mutate: (value) => {
      value.contract_markdown = "# smuggled contract body";
    },
    expected: /fields must be exactly/,
  },
  {
    name: "base64-like contract payload field",
    mutate: (value) => {
      value.contract_b64 = "A".repeat(130);
    },
    expected: /fields must be exactly/,
  },
  {
    name: "missing field",
    mutate: (value) => {
      delete value.source_sha256;
    },
    expected: /fields must be exactly/,
  },
  {
    name: "wrong schema version",
    mutate: (value) => {
      value.schema_version = "openclaw-private-contract-attestation/2";
    },
    expected: /schema_version/,
  },
  {
    name: "repository drift",
    mutate: (value) => {
      value.source_repository = "Olivaryne/other";
    },
    expected: /repository does not match/,
  },
  {
    name: "malformed repository",
    mutate: (value) => {
      value.source_repository = "not a repository";
    },
    expected: /source_repository is malformed/,
  },
  {
    name: "commit drift",
    mutate: (value) => {
      value.source_commit_sha = "e".repeat(40);
    },
    expected: /commit does not match/,
  },
  {
    name: "short commit SHA",
    mutate: (value) => {
      value.source_commit_sha = "abc123";
    },
    expected: /lowercase full 40-character SHA/,
  },
  {
    name: "path drift",
    mutate: (value) => {
      value.source_path = "docs/architecture/other-contract.md";
    },
    expected: /path does not match/,
  },
  {
    name: "absolute source path",
    mutate: (value) => {
      value.source_path = "/etc/contract.md";
    },
    expected: /normalized repository-relative path/,
  },
  {
    name: "traversal source path",
    mutate: (value) => {
      value.source_path = "docs/../../secrets/contract.md";
    },
    expected: /normalized repository-relative path/,
  },
  {
    name: "uppercase blob SHA",
    mutate: (value) => {
      value.source_git_blob_sha = "F".repeat(40);
    },
    expected: /lowercase full 40-character SHA/,
  },
  {
    name: "short blob SHA",
    mutate: (value) => {
      value.source_git_blob_sha = "f3b58c";
    },
    expected: /lowercase full 40-character SHA/,
  },
  {
    name: "digest drift",
    mutate: (value) => {
      value.source_sha256 = "d".repeat(64);
    },
    expected: /digest does not match/,
  },
  {
    name: "uppercase SHA-256",
    mutate: (value) => {
      value.source_sha256 = "C".repeat(64);
    },
    expected: /64-character SHA-256/,
  },
  {
    name: "embedded-content claim",
    mutate: (value) => {
      value.content_embedded = true;
    },
    expected: /must not embed/,
  },
  {
    name: "wrong verification method",
    mutate: (value) => {
      value.verification_method = "remote-private-checkout";
    },
    expected: /verification_method/,
  },
  {
    name: "wrong authority kind",
    mutate: (value) => {
      value.authority_kind = "signed-attestation";
    },
    expected: /authority_kind/,
  },
  {
    name: "secret-shaped value",
    mutate: (value) => {
      value.verification_method = ["ghp", "_", "b".repeat(26)].join("");
    },
    expected: /secret-shaped/,
  },
];

for (const { name, mutate, expected } of attestationMutations) {
  test(`attestation ${name} is rejected`, () => {
    const value = clone(attestation);
    mutate(value);
    assert.throws(() => validateParentAttestation(value, manifest), expected);
  });
}

const attestationRepoPath = path.join(
  root,
  "ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
);

const attestationBytes = fs.readFileSync(attestationRepoPath);
const GOVERNED_ATTESTATION_PATH = "trusted/ci/openclaw/attestations/aut-wb-parent-contract.v1.json";

// Stage a synthetic trusted checkout containing the real (public) attestation
// bytes at the exact governed location. Never stages private contract bytes.
function makeTrustedCheckout() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trusted-")));
  fs.mkdirSync(path.join(base, "trusted/ci/openclaw/attestations"), { recursive: true });
  fs.writeFileSync(path.join(base, GOVERNED_ATTESTATION_PATH), attestationBytes);
  return base;
}

test("exact relative trusted attestation path yields the bounded evidence", () => {
  const base = makeTrustedCheckout();
  try {
    assert.equal(
      readParentAttestation(GOVERNED_ATTESTATION_PATH, manifest, base).verification_mode,
      "trusted-digest-attestation",
    );
  } finally {
    fs.rmSync(base, { recursive: true });
  }
});

test("manifest parent drift away from the attestation is rejected", () => {
  const base = makeTrustedCheckout();
  try {
    const drifted = clone(manifest);
    drifted.parent_contract.sha256 = "0".repeat(64);
    assert.throws(
      () => readParentAttestation(GOVERNED_ATTESTATION_PATH, drifted, base),
      /digest does not match/,
    );
  } finally {
    fs.rmSync(base, { recursive: true });
  }
});

test("absolute and lookalike attestation paths are refused despite valid contents", () => {
  const base = makeTrustedCheckout();
  try {
    const evilDirs = [
      "trusted/ci/openclaw/attestations-evil",
      "other/trusted/ci/openclaw/attestations",
      "source/ci/openclaw/attestations",
      "elsewhere/ci/openclaw/attestations",
    ];
    for (const dir of evilDirs) {
      fs.mkdirSync(path.join(base, dir), { recursive: true });
      fs.writeFileSync(path.join(base, dir, "aut-wb-parent-contract.v1.json"), attestationBytes);
    }

    // 1. absolute path to the valid governed file
    assert.throws(
      () => readParentAttestation(path.join(base, GOVERNED_ATTESTATION_PATH), manifest, base),
      /not absolute/,
    );
    // 2. absolute out-of-tree path whose string contains ci/openclaw/attestations
    assert.throws(
      () =>
        readParentAttestation(
          path.join(base, "elsewhere/ci/openclaw/attestations/aut-wb-parent-contract.v1.json"),
          manifest,
          base,
        ),
      /not absolute/,
    );
    // 3. relative sibling directory lookalike
    assert.throws(
      () =>
        readParentAttestation(
          "trusted/ci/openclaw/attestations-evil/aut-wb-parent-contract.v1.json",
          manifest,
          base,
        ),
      /must be exactly/,
    );
    // 4. embedded lookalike prefix
    assert.throws(
      () =>
        readParentAttestation(
          "other/trusted/ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
          manifest,
          base,
        ),
      /must be exactly/,
    );
    // untrusted source-checkout lookalike stays refused
    assert.throws(
      () =>
        readParentAttestation(
          "source/ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
          manifest,
          base,
        ),
      /must be exactly/,
    );
    // 5. dot-dot traversal
    assert.throws(
      () =>
        readParentAttestation(
          "trusted/ci/openclaw/attestations/../attestations/aut-wb-parent-contract.v1.json",
          manifest,
          base,
        ),
      /dot-dot/,
    );
    // 6. dot normalization
    assert.throws(
      () => readParentAttestation(`./${GOVERNED_ATTESTATION_PATH}`, manifest, base),
      /dot or dot-dot/,
    );
    // 7. repeated separator
    assert.throws(
      () =>
        readParentAttestation(
          "trusted//ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
          manifest,
          base,
        ),
      /empty, dot or dot-dot/,
    );
    // 8. backslash path
    assert.throws(
      () =>
        readParentAttestation(
          "trusted\\ci\\openclaw\\attestations\\aut-wb-parent-contract.v1.json",
          manifest,
          base,
        ),
      /backslashes/,
    );
  } finally {
    fs.rmSync(base, { recursive: true });
  }
});

test("symlinked path components are refused at every level", () => {
  // 9-13: each component from the trusted root to the leaf is swapped for a
  // symlink pointing at a real tree holding valid attestation bytes.
  const symlinkCases = [
    ["trusted", "trusted"],
    ["trusted/ci", "ci"],
    ["trusted/ci/openclaw", "openclaw"],
    ["trusted/ci/openclaw/attestations", "attestations"],
    [GOVERNED_ATTESTATION_PATH, "aut-wb-parent-contract.v1.json"],
  ];
  for (const [linkRelPath, component] of symlinkCases) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-symlink-")));
    try {
      const realTree = path.join(base, "real");
      fs.mkdirSync(path.join(realTree, "trusted/ci/openclaw/attestations"), { recursive: true });
      fs.writeFileSync(path.join(realTree, GOVERNED_ATTESTATION_PATH), attestationBytes);
      fs.mkdirSync(path.dirname(path.join(base, linkRelPath)), { recursive: true });
      fs.symlinkSync(path.join(realTree, linkRelPath), path.join(base, linkRelPath));
      assert.throws(
        () => readParentAttestation(GOVERNED_ATTESTATION_PATH, manifest, base),
        new RegExp(`symbolic link: ${component}`),
        `symlinked ${component} must be refused`,
      );
    } finally {
      fs.rmSync(base, { recursive: true });
    }
  }
});

test("symlinked leaf resolving outside the trusted tree is refused", () => {
  // 14: the final path would resolve entirely outside the trusted checkout.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-escape-")));
  try {
    fs.mkdirSync(path.join(base, "trusted/ci/openclaw/attestations"), { recursive: true });
    fs.writeFileSync(path.join(base, "outside-secret.json"), attestationBytes);
    fs.symlinkSync(
      path.join(base, "outside-secret.json"),
      path.join(base, GOVERNED_ATTESTATION_PATH),
    );
    assert.throws(
      () => readParentAttestation(GOVERNED_ATTESTATION_PATH, manifest, base),
      /symbolic link: aut-wb-parent-contract\.v1\.json/,
    );
  } finally {
    fs.rmSync(base, { recursive: true });
  }
});

test("directory, missing and non-regular objects at the leaf are refused", () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-object-")));
  try {
    // 15. directory at the final file location
    fs.mkdirSync(path.join(base, GOVERNED_ATTESTATION_PATH), { recursive: true });
    assert.throws(
      () => readParentAttestation(GOVERNED_ATTESTATION_PATH, manifest, base),
      /regular file/,
    );
    fs.rmdirSync(path.join(base, GOVERNED_ATTESTATION_PATH));
    // 16. missing file
    assert.throws(
      () => readParentAttestation(GOVERNED_ATTESTATION_PATH, manifest, base),
      /file is missing/,
    );
    // 17. FIFO where the platform supports it
    let fifoMade = false;
    try {
      execFileSync("mkfifo", [path.join(base, GOVERNED_ATTESTATION_PATH)]);
      fifoMade = true;
    } catch {
      // platform without mkfifo: case is exercised on supported platforms only
    }
    if (fifoMade) {
      assert.throws(
        () => readParentAttestation(GOVERNED_ATTESTATION_PATH, manifest, base),
        /regular file/,
      );
    }
  } finally {
    fs.rmSync(base, { recursive: true });
  }
});

function makeChildContractRepo(contents) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-child-")));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const run = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env });
  run(["init", "-q"]);
  fs.mkdirSync(path.join(dir, "contracts/automation"), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts/automation/child.md"), contents);
  run(["add", "."]);
  run(["commit", "-qm", "child contract fixture"]);
  return { dir, sha: run(["rev-parse", "HEAD"]).trim() };
}

test("combined contract verification succeeds and reports the honest parent mode", () => {
  const contents = "# synthetic child contract fixture\n";
  const child = makeChildContractRepo(contents);
  try {
    const fixtureManifest = clone(manifest);
    fixtureManifest.child_contract = {
      repository: manifest.child_contract.repository,
      path: "contracts/automation/child.md",
      commit_sha: child.sha,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
    const trustedBase = makeTrustedCheckout();
    let result;
    try {
      result = verifyContractReferences(
        fixtureManifest,
        child.dir,
        GOVERNED_ATTESTATION_PATH,
        trustedBase,
      );
    } finally {
      fs.rmSync(trustedBase, { recursive: true });
    }
    assert.equal(result.parent.verification_mode, "trusted-digest-attestation");
    assert.equal(result.parent.source_git_blob_sha, attestation.source_git_blob_sha);
    assert.equal(
      result.child,
      `${manifest.child_contract.repository}:contracts/automation/child.md@${child.sha}`,
    );
  } finally {
    fs.rmSync(child.dir, { recursive: true });
  }
});

test("child contract digest drift is rejected", () => {
  const child = makeChildContractRepo("# synthetic child contract fixture\n");
  try {
    const fixtureManifest = clone(manifest);
    fixtureManifest.child_contract = {
      repository: manifest.child_contract.repository,
      path: "contracts/automation/child.md",
      commit_sha: child.sha,
      sha256: "0".repeat(64),
    };
    const trustedBase = makeTrustedCheckout();
    try {
      assert.throws(
        () =>
          verifyContractReferences(
            fixtureManifest,
            child.dir,
            GOVERNED_ATTESTATION_PATH,
            trustedBase,
          ),
        /child contract digest mismatch/,
      );
    } finally {
      fs.rmSync(trustedBase, { recursive: true });
    }
  } finally {
    fs.rmSync(child.dir, { recursive: true });
  }
});

test("child contract commit or path drift is rejected", () => {
  const contents = "# synthetic child contract fixture\n";
  const child = makeChildContractRepo(contents);
  try {
    const fixtureManifest = clone(manifest);
    fixtureManifest.child_contract = {
      repository: manifest.child_contract.repository,
      path: "contracts/automation/absent.md",
      commit_sha: child.sha,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
    const trustedBase = makeTrustedCheckout();
    try {
      assert.throws(() =>
        verifyContractReferences(
          fixtureManifest,
          child.dir,
          GOVERNED_ATTESTATION_PATH,
          trustedBase,
        ),
      );
    } finally {
      fs.rmSync(trustedBase, { recursive: true });
    }
  } finally {
    fs.rmSync(child.dir, { recursive: true });
  }
});

test("action pins, permissions and the five-job set remain unchanged", () => {
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  const byName = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual([...new Set(uses)].toSorted(byName), [
    "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f",
    "actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f",
  ]);
  assert.ok(workflow.includes("permissions:\n  contents: read"));
  assert.equal((workflow.match(/^\s*permissions:/gm) ?? []).length, 1);
  const mutated = `${workflow}\n  extra_job:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 5\n`;
  assert.throws(() => validateWorkflowText(mutated), /job set is not closed/);
});

test("disclosure scanner flags synthetic secret, payload and credential fixtures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-disclosure-"));
  try {
    const fixtures = [
      ["secret.txt", ["ghp", "_", "c".repeat(26)].join(""), "secret-shaped value"],
      ["payload.txt", "Q".repeat(130), "base64-or-archive payload"],
      [
        "url.txt",
        ["https://operator", "hunter2@private.example/veelo.git"].join(":"),
        "credential-bearing URL",
      ],
    ];
    for (const [name, contents, kind] of fixtures) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `${contents}\n`);
      const findings = scanLinesForDisclosure(fs.readFileSync(file, "utf8").split("\n"));
      assert.ok(
        findings.some((finding) => finding.kind === kind),
        `${name} must flag ${kind}`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("remediation surface contains no disclosure-shaped content", () => {
  const remediationFiles = [
    ".github/workflows/openclaw-veelo-ci.yml",
    "ci/openclaw/SECURITY_POLICY.md",
    "ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
    "scripts/ci/openclaw-ci.mjs",
    "scripts/ci/openclaw-ci.test.mjs",
  ];
  for (const file of remediationFiles) {
    const findings = scanLinesForDisclosure(
      fs.readFileSync(path.join(root, file), "utf8").split("\n"),
    );
    assert.deepEqual(findings, [], `${file} must be disclosure-clean`);
  }
  assert.ok(attestationBytes.length < 1024, "attestation must stay tiny with no embedded content");
});

test("valid receipt is accepted", () => {
  assert.equal(validateReceipt(validReceipt(), manifest).final_conclusion, "success");
});

test("receipt identity binds replacement PR #7 and its exact head", () => {
  const accepted = validateReceipt(validReceipt(), manifest);
  assert.equal(accepted.pull_request_number, 7);
  assert.equal(accepted.repository, "Olivaryne/openclaw-veelo");
  assert.equal(accepted.head_sha, accepted.actual_checked_out_sha);
});

test("generic and superseded PR numbers cannot mint a governed receipt", () => {
  for (const number of [3, 4, 12345]) {
    const value = validReceipt();
    value.pull_request_number = number;
    assert.throws(() => validateReceipt(value, manifest), /pull request target mismatch/);
  }
});

test("failed mandatory job blocks the governed receipt", () => {
  const value = validReceipt();
  value.jobs[0].conclusion = "failure";
  assert.throws(() => validateReceipt(value, manifest), /did not succeed/);
});

test("missing mandatory job blocks the governed receipt", () => {
  const value = validReceipt();
  value.jobs.pop();
  assert.throws(() => validateReceipt(value, manifest), /every mandatory job exactly once/);
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

// Synthetic ustar builder for hermetic rollback-package archive tests. Raw
// header bytes let negative cases cover entry types (devices, FIFOs, links)
// that no unprivileged system tar invocation could create.
function tarBlock(name, { type = "0", content = "", linkname = "" } = {}) {
  const body = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  assert.ok(name.length <= 100, "fixture entry names stay within the plain ustar name field");
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write(type, 156, "ascii");
  header.write(linkname, 157, "utf8");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const paddedBody = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(paddedBody);
  return Buffer.concat([header, paddedBody]);
}

function makeTarball(entries) {
  const blocks = entries.map(([name, options]) => tarBlock(name, options));
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const FIXTURE_BUNDLE_ENTRY = "package/dist/sqlite-store-fixture.js";
const FIXTURE_BUNDLE_SOURCE =
  'import { marker } from "./paths-fixture.js";\nconsole.log(`fixture-bundle:${marker}`);\n';

function fixturePackageEntries() {
  return [
    [
      "package/package.json",
      { content: '{"name":"openclaw-rollback-fixture","version":"0.0.0","type":"module"}\n' },
    ],
    [FIXTURE_BUNDLE_ENTRY, { content: FIXTURE_BUNDLE_SOURCE }],
    [
      "package/dist/paths-fixture.js",
      { content: 'export const marker = "paths-module-staged";\n' },
    ],
    ["package/dist/nested/asset.txt", { content: "nested-regular-asset\n" }],
  ];
}

function importBundleInChild(bundleFile) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(pathToFileURL(bundleFile).href)});`,
    ],
    { encoding: "utf8" },
  );
}

function makeExtractionDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

test("single-file staging of the fixture bundle reproduces ERR_MODULE_NOT_FOUND", () => {
  // The previous extraction model staged only the selected bundle file; a
  // child Node import must fail exactly like the governed canary did.
  const dir = makeExtractionDir("openclaw-singlefile-");
  try {
    fs.mkdirSync(path.join(dir, "package/dist"), { recursive: true });
    const bundleFile = path.join(dir, FIXTURE_BUNDLE_ENTRY);
    fs.writeFileSync(bundleFile, FIXTURE_BUNDLE_SOURCE);
    const result = importBundleInChild(bundleFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.match(result.stderr, /paths-fixture\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("complete-package extraction lets a child process import the selected bundle", () => {
  const dir = makeExtractionDir("openclaw-fulltree-");
  try {
    const staged = extractPackageTree(makeTarball(fixturePackageEntries()), dir);
    assert.equal(staged.bundleEntry, FIXTURE_BUNDLE_ENTRY);
    assert.ok(
      staged.bundlePath.startsWith(`${dir}${path.sep}`),
      "bundle path must stay inside the extraction root",
    );
    const result = importBundleInChild(staged.bundlePath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fixture-bundle:paths-module-staged/);
    assert.ok(fs.lstatSync(path.join(dir, "package/package.json")).isFile());
    assert.equal(
      fs.readFileSync(path.join(dir, "package/dist/nested/asset.txt"), "utf8"),
      "nested-regular-asset\n",
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("archive inspection selects exactly one bundle and lists the complete tree", () => {
  const { entries, bundleEntry } = inspectPackageArchive(makeTarball(fixturePackageEntries()));
  assert.equal(bundleEntry, FIXTURE_BUNDLE_ENTRY);
  const byPath = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  assert.deepEqual(
    entries.map((entry) => entry.path).toSorted(byPath),
    [
      "package/dist/nested/asset.txt",
      "package/dist/paths-fixture.js",
      FIXTURE_BUNDLE_ENTRY,
      "package/package.json",
    ].toSorted(byPath),
  );
});

test("explicit directory entries are staged alongside files", () => {
  const dir = makeExtractionDir("openclaw-dirent-");
  try {
    const staged = extractPackageTree(
      makeTarball([
        ["package/", { type: "5" }],
        ["package/dist/", { type: "5" }],
        ...fixturePackageEntries(),
      ]),
      dir,
    );
    assert.ok(fs.lstatSync(staged.bundlePath).isFile());
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

const maliciousArchiveCases = [
  [
    "zero SQLite bundles",
    () => fixturePackageEntries().filter(([name]) => name !== FIXTURE_BUNDLE_ENTRY),
    /expected exactly one packaged SQLite store bundle, found 0/,
  ],
  [
    "two SQLite bundles",
    () => [
      ...fixturePackageEntries(),
      ["package/dist/sqlite-store-second.js", { content: "export {};\n" }],
    ],
    /expected exactly one packaged SQLite store bundle, found 2/,
  ],
  [
    "bundle-named file outside package/dist",
    () =>
      fixturePackageEntries().map(([name, options]) =>
        name === FIXTURE_BUNDLE_ENTRY
          ? ["package/lib/sqlite-store-fixture.js", options]
          : [name, options],
      ),
    /expected exactly one packaged SQLite store bundle, found 0/,
  ],
  [
    "missing package metadata",
    () => fixturePackageEntries().filter(([name]) => name !== "package/package.json"),
    /missing package\/package\.json/,
  ],
  [
    "absolute path",
    () => [...fixturePackageEntries(), ["/package/evil.js", { content: "evil\n" }]],
    /unsafe archive path/,
  ],
  [
    "dot-dot traversal",
    () => [...fixturePackageEntries(), ["package/../evil.js", { content: "evil\n" }]],
    /unsafe archive path/,
  ],
  [
    "entry outside the top-level package directory",
    () => [...fixturePackageEntries(), ["other/evil.js", { content: "evil\n" }]],
    /escapes the top-level package directory/,
  ],
  [
    "symbolic link entry",
    () => [
      ...fixturePackageEntries(),
      ["package/dist/evil-link.js", { type: "2", linkname: "/etc/passwd" }],
    ],
    /prohibited symbolic link entry/,
  ],
  [
    "selected bundle as a symlink",
    () => [
      ...fixturePackageEntries().filter(([name]) => name !== FIXTURE_BUNDLE_ENTRY),
      [FIXTURE_BUNDLE_ENTRY, { type: "2", linkname: "./paths-fixture.js" }],
    ],
    /prohibited symbolic link entry/,
  ],
  [
    "hard link entry",
    () => [
      ...fixturePackageEntries(),
      ["package/dist/evil-hardlink.js", { type: "1", linkname: "package/package.json" }],
    ],
    /prohibited hard link entry/,
  ],
  [
    "FIFO entry",
    () => [...fixturePackageEntries(), ["package/fifo", { type: "6" }]],
    /prohibited FIFO entry/,
  ],
  [
    "character device entry",
    () => [...fixturePackageEntries(), ["package/dev-char", { type: "3" }]],
    /prohibited device entry/,
  ],
  [
    "block device entry",
    () => [...fixturePackageEntries(), ["package/dev-block", { type: "4" }]],
    /prohibited device entry/,
  ],
  [
    "pax extended header entry",
    () => [
      ["package/pax-meta", { type: "x", content: "30 path=package/dist/evil.js\n" }],
      ...fixturePackageEntries(),
    ],
    /unsupported archive entry type/,
  ],
  [
    "unknown entry type",
    () => [...fixturePackageEntries(), ["package/strange", { type: "Z" }]],
    /unsupported archive entry type/,
  ],
  [
    "duplicate path",
    () => [
      ...fixturePackageEntries(),
      ["package/dist/paths-fixture.js", { content: "export const marker = 0;\n" }],
    ],
    /duplicate or conflicting archive path/,
  ],
  [
    "file/parent collision",
    () => [
      ["package/package.json", { content: "{}\n" }],
      ["package/dist", { content: "file-where-directory-belongs\n" }],
      [FIXTURE_BUNDLE_ENTRY, { content: FIXTURE_BUNDLE_SOURCE }],
    ],
    /file\/parent path collision/,
  ],
];

for (const [name, buildEntries, expected] of maliciousArchiveCases) {
  test(`rollback archive with ${String(name)} is refused`, () => {
    assert.throws(() => inspectPackageArchive(makeTarball(buildEntries())), expected);
  });
}

test("truncated rollback archive fails closed", () => {
  const block = tarBlock("package/package.json", { content: "x".repeat(100) });
  assert.throws(
    () => inspectPackageArchive(gzipSync(block.subarray(0, 512))),
    /archive is truncated/,
  );
});

test("missing imported sibling in the synthetic package is refused at staging time", () => {
  const dir = makeExtractionDir("openclaw-nosibling-");
  try {
    const entries = fixturePackageEntries().filter(
      ([name]) => name !== "package/dist/paths-fixture.js",
    );
    assert.throws(
      () => extractPackageTree(makeTarball(entries), dir),
      /relative import is not staged: \.\/paths-fixture\.js/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

function stageExtractedFixtureTree() {
  const dir = makeExtractionDir("openclaw-extracted-");
  fs.mkdirSync(path.join(dir, "package/dist"), { recursive: true });
  const bundleFile = path.join(dir, FIXTURE_BUNDLE_ENTRY);
  fs.writeFileSync(bundleFile, "export {};\n");
  return { dir, bundleFile };
}

test("post-extraction symlink in the staged tree is refused", () => {
  const { dir, bundleFile } = stageExtractedFixtureTree();
  try {
    fs.symlinkSync("/etc/passwd", path.join(dir, "package/dist/evil-link.js"));
    assert.throws(() => verifyExtractedTree(dir, bundleFile), /symbolic link/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("post-extraction non-regular object is refused where supported", () => {
  const { dir, bundleFile } = stageExtractedFixtureTree();
  try {
    let fifoMade = false;
    try {
      execFileSync("mkfifo", [path.join(dir, "package/dist/fifo")]);
      fifoMade = true;
    } catch {
      // platform without mkfifo: case is exercised on supported platforms only
    }
    if (fifoMade) {
      assert.throws(() => verifyExtractedTree(dir, bundleFile), /non-regular object/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("extracted bundle outside package/dist is refused", () => {
  const { dir } = stageExtractedFixtureTree();
  try {
    fs.mkdirSync(path.join(dir, "package/lib"), { recursive: true });
    const strayBundle = path.join(dir, "package/lib/sqlite-store-stray.js");
    fs.writeFileSync(strayBundle, "export {};\n");
    assert.throws(() => verifyExtractedTree(dir, strayBundle), /inside package\/dist/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("missing or non-regular selected bundle is refused", () => {
  const { dir } = stageExtractedFixtureTree();
  try {
    assert.throws(
      () => verifyExtractedTree(dir, path.join(dir, "package/dist/sqlite-store-absent.js")),
      /missing from the extracted tree/,
    );
    const dirBundle = path.join(dir, "package/dist/sqlite-store-dir.js");
    fs.mkdirSync(dirBundle);
    assert.throws(() => verifyExtractedTree(dir, dirBundle), /regular file/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
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
