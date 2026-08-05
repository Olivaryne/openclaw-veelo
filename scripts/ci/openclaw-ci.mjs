#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SRI_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
const VERSION_RE = /^\d{4}\.\d+\.\d+(?:-\d+)?$/;
const CONTRACT_REF_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const ACTION_PINS = new Set([
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f",
  "actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f",
]);
const REQUIRED_JOBS = [
  "workflow-and-scope-integrity",
  "workboard-focused-verification",
  "exact-rollback-fixture",
  "static-and-blast-radius-verification",
];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\bBearer [A-Za-z0-9._~+/-]{20,}=*\b/i,
];

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).toSorted();
  const wanted = expected.toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exactly ${wanted.join(", ")}`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\n")) {
    fail(`${label} must be a non-empty single-line string`);
  }
  return value;
}

function stringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    fail(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} must not contain duplicates`);
  }
  return value;
}

function fullSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    fail(`${label} must be a lowercase full 40-character SHA`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(`${label} must be a lowercase 64-character SHA-256 digest`);
  }
  return value;
}

function safeRelativePath(value, label) {
  nonEmptyString(value, label);
  if (
    path.posix.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    value.startsWith("./")
  ) {
    fail(`${label} must be a normalized repository-relative path`);
  }
  return value;
}

function validateContract(value, label) {
  exactKeys(value, ["commit_sha", "path", "repository", "sha256"], label);
  nonEmptyString(value.repository, `${label}.repository`);
  safeRelativePath(value.path, `${label}.path`);
  fullSha(value.commit_sha, `${label}.commit_sha`);
  digest(value.sha256, `${label}.sha256`);
}

export function validateTargetManifest(value) {
  exactKeys(
    value,
    [
      "base_branch",
      "child_contract",
      "implementation_base_sha",
      "implementation_branch",
      "parent_contract",
      "permitted_files",
      "prohibited_path_classes",
      "pull_request_number",
      "receipt_schema_version",
      "repository",
      "required_blast_radius_commands",
      "required_focused_commands",
      "rollback_fixture_must_run",
      "rollback_package",
      "schema_version",
      "target_id",
    ],
    "target manifest",
  );
  if (value.schema_version !== "openclaw-ci-target/1") {
    fail("unsupported target schema_version");
  }
  if (value.target_id !== "AUT-WB-ATOMIC-SRV-1" && value.target_id !== "OT-GOV-4B") {
    fail("unsupported target_id");
  }
  nonEmptyString(value.repository, "repository");
  if (!Number.isSafeInteger(value.pull_request_number) || value.pull_request_number < 1) {
    fail("pull_request_number must be a positive integer");
  }
  nonEmptyString(value.base_branch, "base_branch");
  nonEmptyString(value.implementation_branch, "implementation_branch");
  fullSha(value.implementation_base_sha, "implementation_base_sha");
  validateContract(value.parent_contract, "parent_contract");
  validateContract(value.child_contract, "child_contract");

  exactKeys(value.permitted_files, ["production", "tests"], "permitted_files");
  const production = stringArray(value.permitted_files.production, "permitted_files.production");
  const tests = stringArray(value.permitted_files.tests, "permitted_files.tests");
  for (const file of [...production, ...tests]) {
    safeRelativePath(file, "permitted file");
  }
  // Per-target file budgets: AUT-WB-ATOMIC froze 4+3; OT-GOV-4B adds
  // dispatcher.ts (declared §16 deviation: four mechanical export keywords).
  const fileBudget = value.target_id === "OT-GOV-4B" ? { production: 5, tests: 3 } : { production: 4, tests: 3 };
  if (production.length !== fileBudget.production || tests.length !== fileBudget.tests) {
    fail("permitted_files does not match the target's frozen file budget");
  }

  if (!Array.isArray(value.prohibited_path_classes)) {
    fail("prohibited_path_classes must be an array");
  }
  const classNames = [];
  for (const [index, entry] of value.prohibited_path_classes.entries()) {
    exactKeys(
      entry,
      ["class", "exact", "prefixes", "segments", "suffixes"],
      `prohibited_path_classes[${index}]`,
    );
    classNames.push(nonEmptyString(entry.class, `prohibited_path_classes[${index}].class`));
    for (const key of ["exact", "prefixes", "segments", "suffixes"]) {
      stringArray(entry[key], `prohibited_path_classes[${index}].${key}`);
    }
  }
  const expectedClasses = ["dependency", "deployment", "generated", "secret-bearing", "workflow"];
  if (!sameStringSet(classNames, expectedClasses)) {
    fail(`prohibited path classes must be exactly ${expectedClasses.join(", ")}`);
  }

  stringArray(value.required_focused_commands, "required_focused_commands");
  stringArray(value.required_blast_radius_commands, "required_blast_radius_commands");
  exactKeys(
    value.rollback_package,
    ["fixture_test_pattern", "name", "registry", "version"],
    "rollback_package",
  );
  if (value.rollback_package.name !== "openclaw") {
    fail("rollback package name must be openclaw");
  }
  if (!VERSION_RE.test(value.rollback_package.version)) {
    fail("rollback package version is malformed");
  }
  if (value.rollback_package.registry !== "https://registry.npmjs.org") {
    fail("rollback registry must be the public npm registry");
  }
  nonEmptyString(value.rollback_package.fixture_test_pattern, "rollback fixture test pattern");
  if (value.rollback_fixture_must_run !== true) {
    fail("rollback_fixture_must_run must be true");
  }
  if (value.receipt_schema_version !== "openclaw-ci-receipt/1") {
    fail("unsupported receipt_schema_version");
  }
  return value;
}

export function readTargetManifest(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`target manifest is not valid JSON: ${error.message}`);
  }
  return validateTargetManifest(parsed);
}

// The parent proof is a trusted digest attestation, not live private-source
// verification: CI never reads the private parent bytes. Every shared field
// must equal the reviewed manifest authority exactly, so the attestation
// cannot retarget the parent or smuggle content past review.
export function validateParentAttestation(value, manifest) {
  exactKeys(
    value,
    [
      "authority_kind",
      "content_embedded",
      "schema_version",
      "source_commit_sha",
      "source_git_blob_sha",
      "source_path",
      "source_repository",
      "source_sha256",
      "verification_method",
    ],
    "parent attestation",
  );
  if (secretMatches(value).length > 0) {
    fail("secret-shaped value found in parent attestation");
  }
  if (value.schema_version !== "openclaw-private-contract-attestation/1") {
    fail("unsupported parent attestation schema_version");
  }
  nonEmptyString(value.source_repository, "parent attestation source_repository");
  if (!REPO_RE.test(value.source_repository)) {
    fail("parent attestation source_repository is malformed");
  }
  safeRelativePath(value.source_path, "parent attestation source_path");
  fullSha(value.source_commit_sha, "parent attestation source_commit_sha");
  fullSha(value.source_git_blob_sha, "parent attestation source_git_blob_sha");
  digest(value.source_sha256, "parent attestation source_sha256");
  if (value.source_repository !== manifest.parent_contract.repository) {
    fail("parent attestation repository does not match manifest authority");
  }
  if (value.source_path !== manifest.parent_contract.path) {
    fail("parent attestation path does not match manifest authority");
  }
  if (value.source_commit_sha !== manifest.parent_contract.commit_sha) {
    fail("parent attestation commit does not match manifest authority");
  }
  if (value.source_sha256 !== manifest.parent_contract.sha256) {
    fail("parent attestation digest does not match manifest authority");
  }
  if (value.verification_method !== "operator-authenticated-private-source-read") {
    fail("unsupported parent attestation verification_method");
  }
  if (value.authority_kind !== "digest-attestation") {
    fail("unsupported parent attestation authority_kind");
  }
  if (value.content_embedded !== false) {
    fail("parent attestation must not embed private contract content");
  }
  return {
    parent_reference: contractReference(manifest.parent_contract),
    source_git_blob_sha: value.source_git_blob_sha,
    source_sha256: value.source_sha256,
    verification_mode: "trusted-digest-attestation",
  };
}

// The only accepted attestation location. The reader proves the supplied
// path is this exact regular file inside the exact trusted checkout tree;
// content validity never rescues an untrusted location.
const TRUSTED_ATTESTATION_FILES = [
  "aut-wb-parent-contract.v1.json",
  "ot-gov-4-parent-contract.v1.json",
];
const TRUSTED_ATTESTATION_PATHS = TRUSTED_ATTESTATION_FILES.map((name) =>
  ["trusted", "ci", "openclaw", "attestations", name].join("/"),
);

// trustedBaseDir exists only so hermetic tests can stage a synthetic trusted
// checkout; the CLI never forwards an argument for it, so production always
// resolves against the workflow working directory that contains `trusted/`.
function assertTrustedAttestationFile(file, trustedBaseDir) {
  nonEmptyString(file, "attestation path");
  if (file.includes("\\")) {
    fail("parent attestation path must not contain backslashes");
  }
  if (path.isAbsolute(file) || path.posix.isAbsolute(file)) {
    fail("parent attestation path must be relative to the trusted checkout, not absolute");
  }
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("parent attestation path must be normalized without empty, dot or dot-dot components");
  }
  if (!TRUSTED_ATTESTATION_PATHS.includes(file)) {
    fail(
      `parent attestation path must be one of: ${TRUSTED_ATTESTATION_PATHS.join(", ")}`,
    );
  }
  if (path.posix.normalize(file) !== file) {
    fail("parent attestation path changes identity under normalization");
  }
  // Walk every component from the trusted checkout root to the leaf; a
  // symlink anywhere on that chain could swap the governed file for
  // attacker-chosen bytes after the lexical checks.
  const fileSegments = file.split("/");
  let current = trustedBaseDir;
  for (const segment of fileSegments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      fail("parent attestation file is missing");
    }
    if (stats.isSymbolicLink()) {
      fail(`parent attestation path component must not be a symbolic link: ${segment}`);
    }
  }
  if (!fs.lstatSync(current).isFile()) {
    fail("parent attestation must be a regular file");
  }
  const expectedDirectory = fs.realpathSync(
    path.join(trustedBaseDir, ...fileSegments.slice(0, -1)),
  );
  const resolvedDirectory = fs.realpathSync(path.dirname(current));
  if (resolvedDirectory !== expectedDirectory) {
    fail("parent attestation directory escapes the trusted checkout");
  }
  const resolvedFile = fs.realpathSync(current);
  if (resolvedFile !== path.join(expectedDirectory, fileSegments.at(-1))) {
    fail("parent attestation file escapes the trusted checkout");
  }
  return current;
}

export function readParentAttestation(file, manifest, trustedBaseDir = process.cwd()) {
  const attestationFile = assertTrustedAttestationFile(file, trustedBaseDir);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(attestationFile, "utf8"));
  } catch (error) {
    fail(`parent attestation is not valid JSON: ${error.message}`);
  }
  return validateParentAttestation(parsed, manifest);
}

function secretMatches(value) {
  const strings = [];
  const visit = (entry) => {
    if (typeof entry === "string") {
      strings.push(entry);
    } else if (Array.isArray(entry)) {
      entry.forEach(visit);
    } else if (isRecord(entry)) {
      Object.entries(entry).forEach(([key, child]) => {
        strings.push(key);
        visit(child);
      });
    }
  };
  visit(value);
  return strings.flatMap((entry) =>
    SECRET_PATTERNS.filter((pattern) => pattern.test(entry)).map(() => entry),
  );
}

// Disclosure guard for the public remediation surface: flags secret-shaped
// values, encoded payloads large enough to carry contract bytes, and
// credential-bearing URLs. It cannot prove the absence of a plain-text
// mirror; the closed attestation shape, exact file budget, and independent
// review own that guarantee.
const DISCLOSURE_PATTERNS = [
  { kind: "base64-or-archive payload", pattern: /[A-Za-z0-9+/]{120,}={0,2}/ },
  { kind: "credential-bearing URL", pattern: /https?:\/\/[^\s/@]+:[^\s/@]+@/i },
];

export function scanLinesForDisclosure(lines) {
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
    fail("disclosure scan input must be an array of strings");
  }
  const findings = [];
  for (const [index, line] of lines.entries()) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ line: index + 1, kind: "secret-shaped value" });
      }
    }
    for (const entry of DISCLOSURE_PATTERNS) {
      if (entry.pattern.test(line)) {
        findings.push({ line: index + 1, kind: entry.kind });
      }
    }
  }
  return findings;
}

function runGit(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding === "buffer" ? null : (options.encoding ?? "utf8"),
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd,
    encoding: "utf8",
  });
  return result.status === 0;
}

function pathMatchesClass(file, entry) {
  const segments = file.split("/");
  return (
    entry.exact.includes(file) ||
    entry.prefixes.some((prefix) => file.startsWith(prefix)) ||
    entry.suffixes.some((suffix) => file.endsWith(suffix)) ||
    entry.segments.some((segment) => segments.includes(segment))
  );
}

function sameStringSet(left, right) {
  return JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());
}

export function validateGovernedScope(manifest, changedFiles) {
  stringArray(changedFiles, "changed files");
  const expected = [...manifest.permitted_files.production, ...manifest.permitted_files.tests];
  if (!sameStringSet(changedFiles, expected)) {
    const unauthorized = changedFiles.filter((file) => !expected.includes(file));
    const missing = expected.filter((file) => !changedFiles.includes(file));
    fail(
      `governed file budget mismatch; unauthorized=${unauthorized.join(",") || "none"}; missing=${
        missing.join(",") || "none"
      }`,
    );
  }
  for (const file of changedFiles) {
    safeRelativePath(file, "changed file");
    for (const entry of manifest.prohibited_path_classes) {
      if (pathMatchesClass(file, entry)) {
        fail(`changed file ${file} matches prohibited ${entry.class} path class`);
      }
    }
  }
}

export function verifyExactHead(actual, expected) {
  fullSha(actual, "actual checked-out SHA");
  fullSha(expected, "expected PR head SHA");
  if (actual !== expected) {
    fail(`exact-head mismatch: expected ${expected}, checked out ${actual}`);
  }
}

function addedDiffLines(cwd, base, head) {
  const diff = runGit(cwd, ["diff", "--no-ext-diff", "--unified=0", `${base}...${head}`]);
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

export function verifyPullRequest({
  sourceDir,
  manifest,
  repository,
  prNumber,
  baseBranch,
  headBranch,
  eventBaseSha,
  expectedHeadSha,
}) {
  fullSha(eventBaseSha, "event base SHA");
  fullSha(expectedHeadSha, "expected head SHA");
  const actualHeadSha = runGit(sourceDir, ["rev-parse", "HEAD"]).trim();
  verifyExactHead(actualHeadSha, expectedHeadSha);

  const mergeBase = runGit(sourceDir, ["merge-base", eventBaseSha, expectedHeadSha]).trim();
  fullSha(mergeBase, "base/head merge-base");
  const governed =
    repository === manifest.repository &&
    Number(prNumber) === manifest.pull_request_number &&
    baseBranch === manifest.base_branch &&
    headBranch === manifest.implementation_branch;

  if (governed) {
    if (mergeBase !== manifest.implementation_base_sha) {
      fail(
        `governed merge-base ${mergeBase} does not equal implementation base ${manifest.implementation_base_sha}`,
      );
    }
    if (
      !isAncestor(sourceDir, manifest.implementation_base_sha, expectedHeadSha) ||
      !isAncestor(sourceDir, manifest.implementation_base_sha, eventBaseSha)
    ) {
      fail("implementation base must be an ancestor of both PR base and exact head");
    }
    const changedFiles = runGit(sourceDir, [
      "diff",
      "--name-only",
      "--diff-filter=ACDMRTUXB",
      `${manifest.implementation_base_sha}...${expectedHeadSha}`,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    validateGovernedScope(manifest, changedFiles);
    const secretHits = addedDiffLines(
      sourceDir,
      manifest.implementation_base_sha,
      expectedHeadSha,
    ).filter((line) => SECRET_PATTERNS.some((pattern) => pattern.test(line)));
    if (secretHits.length > 0) {
      fail("secret-shaped material found in governed added lines");
    }
  }

  return {
    repository,
    pull_request_number: Number(prNumber),
    base_sha: eventBaseSha,
    expected_head_sha: expectedHeadSha,
    actual_checked_out_sha: actualHeadSha,
    merge_base_sha: mergeBase,
    governed,
  };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyContractReferences(
  manifest,
  sourceDir,
  attestationFile,
  trustedBaseDir = process.cwd(),
) {
  // Parent: trusted digest attestation only. Child: exact bytes from the PR
  // source Git history, byte-verified on every run.
  const parentEvidence = readParentAttestation(attestationFile, manifest, trustedBaseDir);

  const childSpec = `${manifest.child_contract.commit_sha}:${manifest.child_contract.path}`;
  const childBytes = runGit(sourceDir, ["show", childSpec], { encoding: "buffer" });
  if (sha256Bytes(childBytes) !== manifest.child_contract.sha256) {
    fail("child contract digest mismatch");
  }
  return {
    parent: parentEvidence,
    child: contractReference(manifest.child_contract),
  };
}

function workflowJobs(text) {
  const jobsIndex = text.indexOf("\njobs:\n");
  if (jobsIndex < 0) {
    fail("workflow must contain jobs");
  }
  const lines = text.slice(jobsIndex + 7).split("\n");
  const jobs = [];
  let current = null;
  for (const line of lines) {
    const match = /^ {2}([a-z][a-z0-9_]*):\s*$/.exec(line);
    if (match) {
      current = { id: match[1], lines: [] };
      jobs.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return jobs;
}

export function validateWorkflowText(text) {
  if (typeof text !== "string" || text.length === 0) {
    fail("workflow must be non-empty text");
  }
  if (/pull_request_target\s*:/.test(text)) {
    fail("pull_request_target is prohibited");
  }
  if (/\bself-hosted\b/i.test(text)) {
    fail("self-hosted runners are prohibited");
  }
  if (/\$\{\{\s*secrets\./i.test(text)) {
    fail("secret expressions are prohibited");
  }
  if (/\bid-token\s*:/i.test(text) || /\bACTIONS_ID_TOKEN_/i.test(text) || /\boidc\b/i.test(text)) {
    fail("OIDC is prohibited");
  }
  if (/^\s+[A-Za-z-]+:\s*write\s*$/m.test(text)) {
    fail("write permissions are prohibited");
  }
  if (/^\s+environment:\s*/m.test(text)) {
    fail("GitHub environments are prohibited");
  }
  if (/^\s+workflow_run:\s*/m.test(text)) {
    fail("privileged workflow_run follow-up is prohibited");
  }
  const packageManagerCacheLines = text.match(/^\s*package-manager-cache:.*$/gm) ?? [];
  if (
    /actions\/cache@/i.test(text) ||
    /^\s+cache:\s*/m.test(text) ||
    /\brestore-keys\s*:/i.test(text) ||
    packageManagerCacheLines.some((line) => line.trim() !== "package-manager-cache: false")
  ) {
    fail("Actions cache use is prohibited");
  }
  for (const match of text.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)) {
    const action = match[1];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/.test(action)) {
      fail(`action reference must be a full commit SHA: ${action}`);
    }
    if (!ACTION_PINS.has(action)) {
      fail(`unauthorized action: ${action}`);
    }
  }
  if ([...text.matchAll(/^\s*uses:\s*/gm)].length === 0) {
    fail("workflow must use the pinned action allowlist");
  }
  const allowedCheckoutRepositories = new Set([
    "${{ github.event.pull_request.head.repo.full_name }}",
    "${{ github.repository }}",
  ]);
  for (const match of text.matchAll(/^\s*repository:\s*(.*?)\s*$/gm)) {
    if (!allowedCheckoutRepositories.has(match[1])) {
      fail(`cross-repository checkout is prohibited: ${match[1]}`);
    }
  }
  // Underscore-style keys only: hyphenated YAML keywords such as
  // persist-credentials never reach this check, and matching is done on the
  // uppercased key so lowercase env names cannot bypass it.
  for (const match of text.matchAll(/^[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/gm)) {
    const key = match[1].toUpperCase();
    if (
      /TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key) ||
      /(?:^|_)PAT(?:_|$)/.test(key) ||
      /PRIVATE_?KEY/.test(key)
    ) {
      fail(`credential-shaped environment name is prohibited: ${match[1]}`);
    }
  }
  for (const match of text.matchAll(/--parent-attestation[ \t]+(\S+)/g)) {
    if (!match[1].startsWith("trusted/ci/openclaw/attestations/")) {
      fail(`parent attestation must come from the trusted attestation directory: ${match[1]}`);
    }
  }
  const requiredFragments = [
    "pull_request:\n    branches:\n      - veelo-main",
    "types: [opened, synchronize, reopened, ready_for_review]",
    "permissions:\n  contents: read",
    "cancel-in-progress: true",
    "repository: ${{ github.event.pull_request.head.repo.full_name }}",
    "ref: ${{ github.event.pull_request.head.sha }}",
    "persist-credentials: false",
    "fetch-depth: 0",
    "package-manager-cache: false",
    "name: workflow-and-scope-integrity",
    "name: workboard-focused-verification",
    "name: exact-rollback-fixture",
    "name: static-and-blast-radius-verification",
    "name: bounded-receipt",
    "validate-attestation",
    // The aut-wb attestation line exists in BOTH workflow epochs (the OT-GOV-4
    // workflow keeps it as a compatibility validation), so it is the required
    // anti-tamper fragment. The ot-gov-4 line exists only in the post-binding
    // workflow and must NOT be required: the governed PR (#19) carries the
    // pre-binding workflow in its source tree, and requiring the new line
    // would make the source-workflow validation unsatisfiable for exactly the
    // PR this binding exists to verify. Attestation-path SAFETY does not live
    // here — every --parent-attestation is prefix-checked against the trusted
    // directory and resolved against the closed TRUSTED_ATTESTATION_PATHS list.
    "--parent-attestation trusted/ci/openclaw/attestations/aut-wb-parent-contract.v1.json",
    "corepack pnpm install --frozen-lockfile",
    "node scripts/run-vitest.mjs extensions/workboard",
    'OPENCLAW_REQUIRE_ROLLBACK_FIXTURE: "1"',
    "OPENCLAW_ROLLBACK_BUNDLE: ${{ steps.package.outputs.bundle_path }}",
    "corepack pnpm tsgo",
    "corepack pnpm tsgo:extensions",
    "corepack pnpm tsgo:extensions:test",
    "corepack pnpm build",
    "corepack pnpm check:import-cycles",
    "node scripts/run-oxlint.mjs",
    "corepack pnpm exec oxfmt --check",
    "compare-audit",
    "generate-receipt",
    "retention-days: 7",
  ];
  for (const fragment of requiredFragments) {
    if (!text.includes(fragment)) {
      fail(`workflow is missing required fragment: ${fragment}`);
    }
  }
  if ((text.match(/^\s*permissions:/gm) ?? []).length !== 1) {
    fail("workflow must declare exactly one top-level permissions block");
  }
  const dangerousCommands = [
    /\bgit\s+push\b/i,
    /\bgh\s+(?:api|pr|issue|release|workflow)\b/i,
    /\bnpm\s+publish\b/i,
    /\bpnpm\s+publish\b/i,
    /\bcurl\b/i,
    /\bwget\b/i,
    /\baws\b/i,
    /\bopenclaw\s+(?:agent|gateway|message|node|update)\b/i,
    /\b(?:deploy|release)\s+(?:create|run|start)\b/i,
  ];
  if (dangerousCommands.some((pattern) => pattern.test(text))) {
    fail("workflow contains a prohibited external-effect command");
  }
  if (
    /\bprintenv\b/i.test(text) ||
    /\/usr\/bin\/env\b/i.test(text) ||
    /\benv\s*\|/.test(text) ||
    /\bexport\s+-p\b/.test(text) ||
    /\bset\s+-x\b/.test(text) ||
    /\bgit\s+config\s+--list\b/.test(text)
  ) {
    fail("workflow contains an environment or credential dump");
  }
  const artifactPathBlock = [
    "${{ runner.temp }}/openclaw-ci-receipt/ci-receipt.json",
    "${{ runner.temp }}/openclaw-ci-receipt/test-summary.txt",
    "${{ runner.temp }}/openclaw-ci-receipt/rollback-package-integrity.txt",
  ];
  for (const artifactPath of artifactPathBlock) {
    if (!text.includes(artifactPath)) {
      fail(`unsafe or missing artifact path: ${artifactPath}`);
    }
  }
  if ((text.match(/actions\/upload-artifact@/g) ?? []).length !== 1) {
    fail("workflow must contain exactly one bounded artifact upload");
  }
  const jobs = workflowJobs(text);
  if (
    !sameStringSet(
      jobs.map((job) => job.id),
      ["blast_radius", "focused", "integrity", "receipt", "rollback"],
    )
  ) {
    fail("workflow job set is not closed");
  }
  for (const job of jobs) {
    if (!job.lines.some((line) => /^\s{4}timeout-minutes:\s*\d+\s*$/.test(line))) {
      fail(`job ${job.id} is missing an explicit timeout`);
    }
    const runnerLines = job.lines.filter((line) => /^\s{4}runs-on:/.test(line));
    if (runnerLines.length !== 1 || runnerLines[0].trim() !== "runs-on: ubuntu-24.04") {
      fail(`job ${job.id} must use only ubuntu-24.04`);
    }
  }
  return { action_count: [...text.matchAll(/^\s*uses:\s*/gm)].length };
}

export function validateWorkflowFile(file) {
  return validateWorkflowText(fs.readFileSync(file, "utf8"));
}

function contractReference(contract) {
  const value = `${contract.repository}:${contract.path}@${contract.commit_sha}`;
  if (!CONTRACT_REF_RE.test(value) || value.includes("..")) {
    fail("malformed contract reference");
  }
  return value;
}

function validateJobResults(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_JOBS.length) {
    fail("receipt jobs must contain every mandatory job exactly once");
  }
  const names = value.map((entry, index) => {
    exactKeys(entry, ["conclusion", "name"], `jobs[${index}]`);
    if (!REQUIRED_JOBS.includes(entry.name)) {
      fail(`unknown mandatory job ${entry.name}`);
    }
    if (!["success", "failure", "cancelled", "skipped"].includes(entry.conclusion)) {
      fail(`unknown job conclusion ${entry.conclusion}`);
    }
    if (entry.conclusion !== "success") {
      fail(`mandatory job ${entry.name} did not succeed`);
    }
    return entry.name;
  });
  if (!sameStringSet(names, REQUIRED_JOBS)) {
    fail("receipt job set mismatch");
  }
}

function validateTestSummaries(value, manifest) {
  exactKeys(value, ["blast_radius", "focused", "rollback"], "test_summaries");
  exactKeys(value.focused, ["commands", "conclusion"], "test_summaries.focused");
  exactKeys(
    value.rollback,
    ["command", "conclusion", "fixture_skipped"],
    "test_summaries.rollback",
  );
  exactKeys(value.blast_radius, ["commands", "conclusion"], "test_summaries.blast_radius");
  if (
    value.focused.conclusion !== "success" ||
    value.rollback.conclusion !== "success" ||
    value.blast_radius.conclusion !== "success"
  ) {
    fail("all test summaries must conclude success");
  }
  if (value.rollback.fixture_skipped !== false) {
    fail("rollback fixture skipped");
  }
  if (!sameStringSet(value.focused.commands, manifest.required_focused_commands)) {
    fail("focused command summary mismatch");
  }
  if (!sameStringSet(value.blast_radius.commands, manifest.required_blast_radius_commands)) {
    fail("blast-radius command summary mismatch");
  }
  if (
    value.rollback.command !==
    `node scripts/run-vitest.mjs extensions/workboard/src/sqlite-store.test.ts -t "${manifest.rollback_package.fixture_test_pattern}"`
  ) {
    fail("rollback command summary mismatch");
  }
}

function validateProhibitedEffects(value) {
  const fields = [
    "actions_cache",
    "aws_access",
    "deployment",
    "external_sends",
    "gateway_access",
    "live_migration",
    "model_provider_calls",
    "production_workboard_access",
    "repository_writes",
    "self_hosted_runner",
    "slack_access",
    "worker_start",
  ];
  exactKeys(value, fields, "prohibited_effects_confirmation");
  for (const field of fields) {
    if (value[field] !== false) {
      fail(`prohibited effect ${field} must be confirmed false`);
    }
  }
}

export function validateReceipt(value, manifest) {
  exactKeys(
    value,
    [
      "actual_checked_out_sha",
      "base_sha",
      "final_conclusion",
      "head_sha",
      "implementation_base_sha",
      "jobs",
      "node_version",
      "parent_contract_reference",
      "child_contract_reference",
      "pnpm_version",
      "prohibited_effects_confirmation",
      "pull_request_number",
      "repository",
      "rollback_fixture_required",
      "rollback_local_artifact_digest",
      "rollback_package_version",
      "rollback_registry_integrity",
      "runner_image",
      "schema_version",
      "target_id",
      "test_summaries",
      "workflow_name",
      "workflow_run_id",
    ],
    "receipt",
  );
  if (secretMatches(value).length > 0) {
    fail("secret-shaped value found in receipt");
  }
  if (value.schema_version !== manifest.receipt_schema_version) {
    fail("receipt schema version mismatch");
  }
  if (value.repository !== manifest.repository) {
    fail("receipt repository target mismatch");
  }
  if (value.pull_request_number !== manifest.pull_request_number) {
    fail("receipt pull request target mismatch");
  }
  fullSha(value.base_sha, "receipt base_sha");
  fullSha(value.head_sha, "receipt head_sha");
  fullSha(value.actual_checked_out_sha, "receipt actual_checked_out_sha");
  fullSha(value.implementation_base_sha, "receipt implementation_base_sha");
  if (value.head_sha !== value.actual_checked_out_sha) {
    fail("receipt checked-out head mismatch");
  }
  if (value.implementation_base_sha !== manifest.implementation_base_sha) {
    fail("receipt implementation base mismatch");
  }
  if (typeof value.workflow_run_id !== "string" || !/^[1-9]\d*$/.test(value.workflow_run_id)) {
    fail("workflow_run_id must be a positive decimal string");
  }
  if (value.workflow_name !== "OpenClaw Veelo Secret-Safe Verification") {
    fail("workflow name mismatch");
  }
  if (value.runner_image !== "ubuntu-24.04") {
    fail("runner image mismatch");
  }
  if (typeof value.node_version !== "string" || !/^v24\.\d+\.\d+$/.test(value.node_version)) {
    fail("Node version is malformed");
  }
  if (typeof value.pnpm_version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.pnpm_version)) {
    fail("pnpm version is malformed");
  }
  if (value.target_id !== manifest.target_id) {
    fail("receipt governed target mismatch");
  }
  if (
    value.parent_contract_reference !== contractReference(manifest.parent_contract) ||
    value.child_contract_reference !== contractReference(manifest.child_contract)
  ) {
    fail("receipt contract reference mismatch");
  }
  if (value.rollback_package_version !== manifest.rollback_package.version) {
    fail("rollback package version mismatch");
  }
  if (!SRI_RE.test(value.rollback_registry_integrity)) {
    fail("invalid rollback registry integrity");
  }
  if (
    typeof value.rollback_local_artifact_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.rollback_local_artifact_digest)
  ) {
    fail("invalid rollback local artifact digest");
  }
  if (value.rollback_fixture_required !== true) {
    fail("missing rollback proof");
  }
  validateJobResults(value.jobs);
  validateTestSummaries(value.test_summaries, manifest);
  if (value.final_conclusion !== "success") {
    fail("final conclusion must be success");
  }
  validateProhibitedEffects(value.prohibited_effects_confirmation);
  return value;
}

function appendGitHubOutput(file, values) {
  if (!file) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => {
    const rendered = String(value);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || rendered.includes("\n")) {
      fail("unsafe GitHub output");
    }
    return `${key}=${rendered}`;
  });
  fs.appendFileSync(file, `${lines.join("\n")}\n`, { encoding: "utf8" });
}

// The selected bundle carries relative imports to sibling package files, so
// the complete package runtime tree must be staged, not one file. Extraction
// is pure in-process parsing of the exact integrity-verified tarball bytes:
// no tar subprocess, no symlink following, no lifecycle scripts.
const PACKAGE_BUNDLE_RE = /^package\/dist\/sqlite-store-[A-Za-z0-9_-]+\.js$/;
const MAX_EXTRACTED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const TAR_BLOCK = 512;

function gunzipPackageArchive(tarball) {
  try {
    return gunzipSync(tarball, { maxOutputLength: MAX_EXTRACTED_ARCHIVE_BYTES });
  } catch (error) {
    return fail(`rollback package archive failed to decompress safely: ${error.message}`);
  }
}

function tarString(block, start, length) {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

function tarNumber(block, start, length, label) {
  const raw = block.subarray(start, start + length);
  if (raw.length > 0 && (raw[0] & 0x80) !== 0) {
    fail(`${label} uses an unsupported binary tar encoding`);
  }
  const text = tarString(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    fail(`${label} is not a valid octal tar field`);
  }
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function assertTarHeaderChecksum(block) {
  const expected = tarNumber(block, 148, 8, "tar header checksum");
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (sum !== expected) {
    fail("rollback package archive entry has an invalid header checksum");
  }
}

function assertSafeArchiveEntryPath(name) {
  if (
    name.length === 0 ||
    name.includes("\\") ||
    name.includes("\0") ||
    path.posix.isAbsolute(name)
  ) {
    fail(`rollback package contains an unsafe archive path: ${name}`);
  }
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`rollback package contains an unsafe archive path: ${name}`);
  }
  if (normalized !== "package" && !normalized.startsWith("package/")) {
    fail(`rollback package entry escapes the top-level package directory: ${name}`);
  }
  return normalized;
}

function assertSupportedEntryType(typeFlag, entryPath) {
  if (typeFlag === "1") {
    fail(`rollback package contains a prohibited hard link entry: ${entryPath}`);
  }
  if (typeFlag === "2") {
    fail(`rollback package contains a prohibited symbolic link entry: ${entryPath}`);
  }
  if (typeFlag === "3" || typeFlag === "4") {
    fail(`rollback package contains a prohibited device entry: ${entryPath}`);
  }
  if (typeFlag === "6") {
    fail(`rollback package contains a prohibited FIFO entry: ${entryPath}`);
  }
  if (typeFlag !== "0" && typeFlag !== "5") {
    fail(`rollback package contains an unsupported archive entry type "${typeFlag}": ${entryPath}`);
  }
}

function parsePackageArchive(data) {
  const filePaths = new Set();
  const directoryPaths = new Set();
  const explicitDirectoryPaths = new Set();
  const entries = [];
  const bundles = [];
  // Duplicate/conflict ledger: a path may appear once, a file may never be
  // reused as a parent directory, and implicit parents of every entry are
  // tracked so file/parent collisions fail in either archive order.
  const recordTreePath = (entryPath, kind) => {
    if (
      filePaths.has(entryPath) ||
      (kind === "file" && directoryPaths.has(entryPath)) ||
      (kind === "directory" && explicitDirectoryPaths.has(entryPath))
    ) {
      fail(`rollback package contains a duplicate or conflicting archive path: ${entryPath}`);
    }
    const segments = entryPath.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      if (filePaths.has(ancestor)) {
        fail(`rollback package contains a file/parent path collision: ${entryPath}`);
      }
      directoryPaths.add(ancestor);
    }
    if (kind === "file") {
      filePaths.add(entryPath);
    } else {
      explicitDirectoryPaths.add(entryPath);
      directoryPaths.add(entryPath);
    }
  };
  let offset = 0;
  while (true) {
    if (offset + TAR_BLOCK > data.length) {
      fail("rollback package archive is truncated");
    }
    const block = data.subarray(offset, offset + TAR_BLOCK);
    if (block.every((byte) => byte === 0)) {
      if (!data.subarray(offset).every((byte) => byte === 0)) {
        fail("rollback package archive has data after its end-of-archive marker");
      }
      break;
    }
    assertTarHeaderChecksum(block);
    if (tarString(block, 257, 6) !== "ustar") {
      fail("rollback package archive entry is not ustar-formatted");
    }
    const nameField = tarString(block, 0, 100);
    const prefixField = tarString(block, 345, 155);
    const rawName = prefixField.length > 0 ? `${prefixField}/${nameField}` : nameField;
    const size = tarNumber(block, 124, 12, `archive entry size for ${rawName}`);
    const typeFlag = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    offset += TAR_BLOCK;
    const dataEnd = offset + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (dataEnd > data.length) {
      fail("rollback package archive is truncated");
    }
    const entryPath = assertSafeArchiveEntryPath(rawName);
    assertSupportedEntryType(typeFlag, entryPath);
    const kind = typeFlag === "5" ? "directory" : "file";
    recordTreePath(entryPath, kind);
    if (kind === "file" && PACKAGE_BUNDLE_RE.test(entryPath)) {
      bundles.push(entryPath);
    }
    entries.push({ path: entryPath, kind, start: offset, size });
    offset = dataEnd;
  }
  if (bundles.length !== 1) {
    fail(`expected exactly one packaged SQLite store bundle, found ${bundles.length}`);
  }
  if (!filePaths.has("package/package.json")) {
    fail("rollback package is missing package/package.json");
  }
  return { entries, bundleEntry: bundles[0] };
}

export function inspectPackageArchive(tarball) {
  return parsePackageArchive(gunzipPackageArchive(tarball));
}

export function verifyExtractedTree(rootDir, bundlePath) {
  const resolvedRoot = fs.realpathSync(rootDir);
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).toSorted()) {
      const child = path.join(dir, name);
      const stats = fs.lstatSync(child);
      if (stats.isSymbolicLink()) {
        fail(`extracted rollback tree contains a symbolic link: ${name}`);
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        fail(`extracted rollback tree contains a non-regular object: ${name}`);
      }
      if (!fs.realpathSync(child).startsWith(`${resolvedRoot}${path.sep}`)) {
        fail(`extracted rollback path escapes the extraction root: ${name}`);
      }
      if (stats.isDirectory()) {
        walk(child);
      }
    }
  };
  walk(resolvedRoot);
  let bundleStats;
  try {
    bundleStats = fs.lstatSync(bundlePath);
  } catch {
    fail("rollback bundle is missing from the extracted tree");
  }
  if (!bundleStats.isFile()) {
    fail("rollback bundle must be a regular file");
  }
  // The symlink-free walk means realpath equals the literal path, so the
  // resolved bundle must sit directly inside <root>/package/dist.
  const expectedDist = path.join(resolvedRoot, "package", "dist");
  let resolvedBundle;
  let resolvedDist;
  try {
    resolvedBundle = fs.realpathSync(bundlePath);
    resolvedDist = fs.realpathSync(expectedDist);
  } catch {
    fail("rollback bundle must resolve inside package/dist");
  }
  if (resolvedDist !== expectedDist || path.dirname(resolvedBundle) !== expectedDist) {
    fail("rollback bundle must resolve inside package/dist");
  }
}

const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s*["'](\.{1,2}\/[^"'\n]+)["']/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g,
  /\bimport\s*["'](\.{1,2}\/[^"'\n]+)["']/g,
  /\brequire\s*\(\s*["'](\.{1,2}\/[^"'\n]+)["']\s*\)/g,
];

// Bounded closure proof: every package-relative import of the selected bundle
// must exist as a staged regular file. The mandatory rollback fixture stays
// the authoritative behavior proof; this only guarantees the staged tree was
// not reduced back to a single bundle file.
function assertBundleImportClosure(rootDir, bundlePath) {
  const resolvedRoot = fs.realpathSync(rootDir);
  const source = fs.readFileSync(bundlePath, "utf8");
  const specifiers = new Set();
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      specifiers.add(match[1]);
    }
  }
  const bySpecifier = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
  for (const specifier of [...specifiers].toSorted(bySpecifier)) {
    const resolved = path.resolve(path.dirname(bundlePath), specifier);
    if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      fail(`rollback bundle relative import escapes the extraction root: ${specifier}`);
    }
    let stats;
    try {
      stats = fs.lstatSync(resolved);
    } catch {
      stats = null;
    }
    if (!stats?.isFile()) {
      fail(`rollback bundle relative import is not staged: ${specifier}`);
    }
  }
}

export function extractPackageTree(tarball, destinationDir) {
  const data = gunzipPackageArchive(tarball);
  const { entries, bundleEntry } = parsePackageArchive(data);
  const resolvedRoot = fs.realpathSync(destinationDir);
  for (const entry of entries) {
    const target = path.join(resolvedRoot, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // wx: parse-time duplicate checks make an existing target impossible;
    // fail closed instead of overwriting if that invariant ever breaks.
    fs.writeFileSync(target, data.subarray(entry.start, entry.start + entry.size), {
      flag: "wx",
      mode: 0o644,
    });
  }
  const bundlePath = path.join(resolvedRoot, ...bundleEntry.split("/"));
  verifyExtractedTree(resolvedRoot, bundlePath);
  assertBundleImportClosure(resolvedRoot, bundlePath);
  return { bundleEntry, bundlePath };
}

export function prepareRollbackPackage(manifest, outputDir, githubOutput) {
  fs.mkdirSync(outputDir, { recursive: true });
  const spec = `${manifest.rollback_package.name}@${manifest.rollback_package.version}`;
  const registryArg = `--registry=${manifest.rollback_package.registry}`;
  const metadataRaw = execFileSync(
    "npm",
    ["view", spec, "version", "dist.integrity", "--json", registryArg],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const metadata = JSON.parse(metadataRaw);
  if (
    metadata.version !== manifest.rollback_package.version ||
    !SRI_RE.test(metadata["dist.integrity"])
  ) {
    fail("npm registry returned a mismatched version or invalid integrity");
  }
  const packRaw = execFileSync(
    "npm",
    ["pack", spec, "--json", "--ignore-scripts", `--pack-destination=${outputDir}`, registryArg],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const pack = JSON.parse(packRaw);
  if (!Array.isArray(pack) || pack.length !== 1) {
    fail("npm pack returned an unexpected result");
  }
  const filename = path.basename(pack[0].filename ?? "");
  if (!filename || filename !== pack[0].filename) {
    fail("npm pack returned an unsafe filename");
  }
  const archive = path.join(outputDir, filename);
  const bytes = fs.readFileSync(archive);
  const actualSri = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (actualSri !== metadata["dist.integrity"]) {
    fail("downloaded rollback package does not match registry integrity");
  }
  const artifactDigest = `sha256:${sha256Bytes(bytes)}`;
  // Stage the complete package runtime tree from the verified bytes: the
  // selected bundle imports sibling dist modules, so single-file staging
  // breaks the mandatory rollback fixture with ERR_MODULE_NOT_FOUND.
  const extractedRoot = fs.mkdtempSync(path.join(outputDir, "package-"));
  const staged = extractPackageTree(bytes, extractedRoot);
  const proof = {
    package_version: metadata.version,
    registry_integrity: metadata["dist.integrity"],
    artifact_digest: artifactDigest,
    bundle_entry: staged.bundleEntry,
    bundle_path: staged.bundlePath,
  };
  appendGitHubOutput(githubOutput, proof);
  return proof;
}

function runAudit(cwd) {
  const result = spawnSync(
    "corepack",
    ["pnpm", "audit", "--prod", "--json", "--registry=https://registry.npmjs.org"],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (![0, 1].includes(result.status)) {
    fail(`pnpm audit failed to produce a comparison payload in ${cwd}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fail(`pnpm audit returned malformed JSON in ${cwd}`);
  }
}

function normalizedAuditFindings(value) {
  if (isRecord(value.advisories)) {
    return Object.values(value.advisories)
      .map((entry) => ({
        id: entry.id,
        module_name: entry.module_name,
        severity: entry.severity,
        vulnerable_versions: entry.vulnerable_versions,
      }))
      .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (isRecord(value.vulnerabilities)) {
    return Object.entries(value.vulnerabilities)
      .map(([name, entry]) => ({
        name,
        severity: entry.severity,
        via: Array.isArray(entry.via)
          ? entry.via
              .map((via) => (isRecord(via) ? `${via.source}:${via.range}` : String(via)))
              .toSorted()
          : [],
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }
  return [];
}

export function compareDependencyAudits(baseDir, headDir) {
  const base = normalizedAuditFindings(runAudit(baseDir));
  const head = normalizedAuditFindings(runAudit(headDir));
  if (JSON.stringify(base) !== JSON.stringify(head)) {
    fail("dependency audit finding set differs between exact base and head");
  }
  return { findings: head.length, delta: 0 };
}

function receiptFromEnvironment(manifest, env) {
  let jobs;
  try {
    jobs = JSON.parse(env.CI_JOBS_JSON);
  } catch {
    fail("CI_JOBS_JSON must be valid JSON");
  }
  return {
    schema_version: manifest.receipt_schema_version,
    repository: env.CI_REPOSITORY,
    pull_request_number: Number(env.CI_PR_NUMBER),
    base_sha: env.CI_BASE_SHA,
    head_sha: env.CI_HEAD_SHA,
    actual_checked_out_sha: env.CI_ACTUAL_HEAD_SHA,
    implementation_base_sha: manifest.implementation_base_sha,
    workflow_run_id: env.CI_WORKFLOW_RUN_ID,
    workflow_name: env.CI_WORKFLOW_NAME,
    jobs,
    runner_image: env.CI_RUNNER_IMAGE,
    node_version: env.CI_NODE_VERSION,
    pnpm_version: env.CI_PNPM_VERSION,
    target_id: manifest.target_id,
    parent_contract_reference: contractReference(manifest.parent_contract),
    child_contract_reference: contractReference(manifest.child_contract),
    rollback_package_version: env.CI_ROLLBACK_VERSION,
    rollback_registry_integrity: env.CI_ROLLBACK_INTEGRITY,
    rollback_local_artifact_digest: env.CI_ROLLBACK_DIGEST,
    rollback_fixture_required: true,
    test_summaries: {
      focused: {
        conclusion: "success",
        commands: manifest.required_focused_commands,
      },
      rollback: {
        conclusion: "success",
        fixture_skipped: false,
        command: `node scripts/run-vitest.mjs extensions/workboard/src/sqlite-store.test.ts -t "${manifest.rollback_package.fixture_test_pattern}"`,
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

export function writeReceiptArtifacts(manifest, outputDir, env = process.env) {
  const receipt = validateReceipt(receiptFromEnvironment(manifest, env), manifest);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    path.join(outputDir, "ci-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { mode: 0o600 },
  );
  const summary = [
    `schema=${receipt.schema_version}`,
    `repository=${receipt.repository}`,
    `pr=${receipt.pull_request_number}`,
    `base=${receipt.base_sha}`,
    `head=${receipt.head_sha}`,
    `target=${receipt.target_id}`,
    ...receipt.jobs.map((job) => `job.${job.name}=${job.conclusion}`),
    `final=${receipt.final_conclusion}`,
  ];
  fs.writeFileSync(path.join(outputDir, "test-summary.txt"), `${summary.join("\n")}\n`, {
    mode: 0o600,
  });
  const rollback = [
    `package=${manifest.rollback_package.name}`,
    `version=${receipt.rollback_package_version}`,
    `registry=${manifest.rollback_package.registry}`,
    `registry_integrity=${receipt.rollback_registry_integrity}`,
    `local_artifact_digest=${receipt.rollback_local_artifact_digest}`,
    "fixture_required=true",
    "fixture_skipped=false",
  ];
  fs.writeFileSync(
    path.join(outputDir, "rollback-package-integrity.txt"),
    `${rollback.join("\n")}\n`,
    { mode: 0o600 },
  );
  return receipt;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("arguments must be --name value pairs");
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function requiredArg(args, name) {
  return nonEmptyString(args[name], `--${name}`);
}

function printResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "validate-target") {
    printResult({
      valid: true,
      target_id: readTargetManifest(requiredArg(args, "manifest")).target_id,
    });
    return;
  }
  if (command === "validate-workflow") {
    printResult({ valid: true, ...validateWorkflowFile(requiredArg(args, "workflow")) });
    return;
  }
  if (command === "validate-attestation") {
    const manifest = readTargetManifest(requiredArg(args, "manifest"));
    const evidence = readParentAttestation(requiredArg(args, "parent-attestation"), manifest);
    printResult({ valid: true, ...evidence });
    return;
  }
  if (command === "verify-pr") {
    const manifest = readTargetManifest(requiredArg(args, "manifest"));
    const result = verifyPullRequest({
      sourceDir: requiredArg(args, "source"),
      manifest,
      repository: requiredArg(args, "repository"),
      prNumber: requiredArg(args, "pr-number"),
      baseBranch: requiredArg(args, "base-branch"),
      headBranch: requiredArg(args, "head-branch"),
      eventBaseSha: requiredArg(args, "base-sha"),
      expectedHeadSha: requiredArg(args, "head-sha"),
    });
    appendGitHubOutput(args["github-output"], {
      governed: result.governed,
      actual_head_sha: result.actual_checked_out_sha,
    });
    printResult(result);
    return;
  }
  if (command === "verify-contracts") {
    const manifest = readTargetManifest(requiredArg(args, "manifest"));
    printResult(
      verifyContractReferences(
        manifest,
        requiredArg(args, "source"),
        requiredArg(args, "parent-attestation"),
      ),
    );
    return;
  }
  if (command === "prepare-rollback") {
    const manifest = readTargetManifest(requiredArg(args, "manifest"));
    const result = prepareRollbackPackage(
      manifest,
      requiredArg(args, "output-dir"),
      args["github-output"],
    );
    printResult({ ...result, bundle_path: path.basename(result.bundle_path) });
    return;
  }
  if (command === "compare-audit") {
    printResult(compareDependencyAudits(requiredArg(args, "base"), requiredArg(args, "head")));
    return;
  }
  if (command === "generate-receipt") {
    const manifest = readTargetManifest(requiredArg(args, "manifest"));
    const receipt = writeReceiptArtifacts(manifest, requiredArg(args, "output-dir"));
    printResult({ valid: true, head_sha: receipt.head_sha });
    return;
  }
  fail(`unknown command ${command ?? ""}`);
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`openclaw-ci: ${error.message}\n`);
    process.exitCode = 1;
  }
}
