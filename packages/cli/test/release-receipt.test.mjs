import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createAnnotatedReleaseTag,
  RELEASE_FULL_GATE_COMMAND,
  RELEASE_RECEIPT_PROTOCOL,
  releaseReceiptCandidate,
  releaseReceiptProjection,
  releaseTagAdmissionFailures,
  releaseTagProjection,
  runReleaseFullGate,
} from "../src/release-receipt.mjs";

const sha = "a".repeat(64);

const projection = (overrides = {}) => ({
  release: {
    version: "1.2.3",
    packages: [{ publicName: "@scope/core" }, { publicName: "@scope/runtime" }],
  },
  source: { status: "available", dirty: false, head: "commit-123" },
  artifacts: {
    status: "verified",
    sha256: "b".repeat(64),
    packages: [
      {
        packageName: "@scope/core",
        status: "verified",
        packageNameReadback: "@scope/core",
        packageVersion: "1.2.3",
        actualSha256: sha,
      },
      {
        packageName: "@scope/runtime",
        status: "verified",
        packageNameReadback: "@scope/runtime",
        packageVersion: "1.2.3",
        actualSha256: "c".repeat(64),
      },
    ],
  },
  exportEquivalence: { status: "verified" },
  npm: {
    status: "checked",
    packages: {
      "@scope/core": { status: "resolved", distTags: { latest: "1.2.3" } },
      "@scope/runtime": { status: "resolved", distTags: { latest: "1.2.3" } },
    },
  },
  tag: { owner: "git", name: "v1.2.3", status: "missing" },
  ...overrides,
});

void test("release tag admission proves clean source and exact npm/tarball train", () => {
  const status = projection();
  assert.deepEqual(releaseTagAdmissionFailures(status), []);
  assert.deepEqual(releaseReceiptCandidate(status), {
    schema: RELEASE_RECEIPT_PROTOCOL,
    version: "1.2.3",
    sourceCommit: "commit-123",
    gate: { command: RELEASE_FULL_GATE_COMMAND, status: "passed" },
    installManifestSha256: "b".repeat(64),
    packages: [
      {
        name: "@scope/core",
        npmVersion: "1.2.3",
        tarballName: "@scope/core",
        tarballVersion: "1.2.3",
        tarballSha256: sha,
      },
      {
        name: "@scope/runtime",
        npmVersion: "1.2.3",
        tarballName: "@scope/runtime",
        tarballVersion: "1.2.3",
        tarballSha256: "c".repeat(64),
      },
    ],
  });
});

void test("release tag admission fails closed on every mismatched owner projection", () => {
  const status = projection({
    source: { status: "available", dirty: true, head: "commit-123" },
    artifacts: {
      ...projection().artifacts,
      packages: [
        {
          packageName: "@scope/core",
          status: "verified",
          packageNameReadback: "@scope/core",
          packageVersion: "9.9.9",
          actualSha256: sha,
        },
      ],
    },
    npm: {
      status: "checked",
      packages: {
        "@scope/core": { status: "resolved", distTags: { latest: "9.9.9" } },
      },
    },
  });
  assert.deepEqual(releaseTagAdmissionFailures(status), [
    "source_not_clean",
    "artifact_package_set_mismatch",
    "npm_package_set_mismatch",
    "tarball_version_mismatch:@scope/core",
    "npm_version_mismatch:@scope/core",
    "tarball_not_verified:@scope/runtime",
    "tarball_name_mismatch:@scope/runtime",
    "tarball_version_mismatch:@scope/runtime",
    "npm_unresolved:@scope/runtime",
    "npm_version_mismatch:@scope/runtime",
  ]);
});

void test("release receipt verifies only an annotated tag over current owned facts", () => {
  const status = projection();
  assert.deepEqual(releaseReceiptProjection(status).status, "not_issued");
  const receipt = releaseReceiptCandidate(status);
  assert.deepEqual(
    releaseReceiptProjection({
      ...status,
      tag: {
        owner: "git",
        name: "v1.2.3",
        status: "annotated",
        commit: status.source.head,
        receipt,
      },
    }),
    { status: "verified", expected: receipt, observed: receipt, failures: [] },
  );
  const failed = releaseReceiptProjection({
    ...status,
    tag: {
      owner: "git",
      name: "v1.2.3",
      status: "annotated",
      commit: "other",
      receipt: { ...receipt, version: "9.9.9" },
    },
  });
  assert.deepEqual(failed.failures, [
    "release_tag_commit_mismatch",
    "release_receipt_fact_mismatch",
  ]);
  const uncheckedNpm = releaseReceiptProjection({
    ...status,
    npm: { status: "not_checked" },
    tag: {
      owner: "git",
      name: "v1.2.3",
      status: "annotated",
      commit: "other",
      receipt,
    },
  });
  assert.equal(uncheckedNpm.status, "failed");
  assert.deepEqual(uncheckedNpm.failures, ["release_tag_commit_mismatch"]);
});

void test("annotated tag creation roundtrips canonical receipt without becoming version input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-release-receipt-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "agentos-test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "agentos@example.test"], { cwd: root });
    fs.writeFileSync(path.join(root, "fact.txt"), "owner\n");
    execFileSync("git", ["add", "fact.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "test: owner fact"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const status = projection({
      source: { status: "available", dirty: false, head },
      tag: releaseTagProjection(root, "1.2.3"),
    });
    const created = createAnnotatedReleaseTag(root, status);
    assert.equal(created.tag.status, "annotated");
    assert.equal(created.tag.commit, head);
    assert.deepEqual(created.tag.receipt, releaseReceiptCandidate(status));
    assert.throws(() => createAnnotatedReleaseTag(root, { ...status, tag: created.tag }), {
      message: /release_tag_already_exists/u,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("full release gate command is fixed and must exit zero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-release-gate-"));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-release-gate-bin-"));
  const sentinel = path.join(root, "args.txt");
  const originalPath = process.env.PATH;
  try {
    const pnpm = path.join(bin, "pnpm");
    fs.writeFileSync(pnpm, `#!/bin/sh\nprintf '%s\\n' "$@" > "${sentinel}"\n`);
    fs.chmodSync(pnpm, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    runReleaseFullGate(root);
    assert.deepEqual(fs.readFileSync(sentinel, "utf8").trim().split("\n"), ["run", "check:full"]);
    fs.writeFileSync(pnpm, "#!/bin/sh\nexit 7\n");
    assert.throws(() => runReleaseFullGate(root), { message: /check:full failed/u });
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
