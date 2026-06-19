#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();

const files = {
  profile: "packages/backends/cloudflare-do/src/workspace-job-profile.ts",
  facade: "packages/backends/cloudflare-do/src/workspace-job-facade.ts",
  index: "packages/backends/cloudflare-do/src/index.ts",
  fixture: "packages/backends/cloudflare-do/test/consumer-fixture/public.ts",
  test: "packages/backends/cloudflare-do/test/workspace-host-helpers.test.ts",
};

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const requireTerms = (failures, source, file, terms) => {
  for (const term of terms) {
    if (!source.includes(term)) failures.push(`${file}: missing ${term}`);
  }
};

const rejectPatterns = (failures, source, file, patterns) => {
  for (const [pattern, description] of patterns) {
    if (pattern.test(source)) failures.push(`${file}: ${description}`);
  }
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const profile = read(root, files.profile);
  const facade = read(root, files.facade);
  const index = read(root, files.index);
  const fixture = read(root, files.fixture);
  const test = read(root, files.test);

  requireTerms(failures, facade, files.facade, [
    "CloudflareWorkspaceJobResponseProjection",
    "CloudflareWorkspaceJobResponseOptions<",
    "Projection extends CloudflareWorkspaceJobResponseProjection",
  ]);
  requireTerms(failures, profile, files.profile, [
    "WorkspaceJobObservabilityProjection",
    "installCloudflareWorkspaceOperationProvider",
    "createCloudflareWorkspaceJobResponse<WorkspaceJobObservabilityProjection>",
    "createCloudflareLedgerAgUiSseResponse",
    "createCloudflareLedgerAgUiHistorySseResponse",
    "options.workspaceResolver",
    ".resolve({",
    "options.readProjection",
  ]);
  rejectPatterns(failures, profile, files.profile, [
    [/\bWorkspaceJobProjection\b/u, "profile must not depend on raw workspace-job projection"],
    [
      /workspaceJobFailedPayload|projectWorkspaceJob\(/u,
      "profile must not parse workspace-job facts",
    ],
    [
      /category\s*:|owner\s*:|publicMessage\s*:|diagnostics\s*:/u,
      "profile must not own failure taxonomy",
    ],
  ]);
  requireTerms(failures, index, files.index, ['export * from "./workspace-job-profile";']);
  requireTerms(failures, fixture, files.fixture, [
    "installCloudflareWorkspaceJobProfile",
    "fixtureWorkspaceJobProfile",
  ]);
  requireTerms(failures, test, files.test, [
    "installs a workspace-job profile over sanitized projection and existing host helpers",
    "failedObservabilityProjection",
    'not.toContain("submitRunId")',
    "profile.createAgUiHistorySseResponse",
    "profile.workspaceOperations.eventHandlers",
  ]);

  return failures;
};

const writeFixture = (root, file, source) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-cloudflare-profile-"));
  try {
    writeFixture(
      root,
      files.facade,
      [
        "export type CloudflareWorkspaceJobResponseProjection = unknown;",
        "export interface CloudflareWorkspaceJobResponseOptions<Projection extends CloudflareWorkspaceJobResponseProjection> {}",
      ].join("\n"),
    );
    writeFixture(
      root,
      files.profile,
      [
        "import type { WorkspaceJobObservabilityProjection } from '@agent-os/runtime';",
        "installCloudflareWorkspaceOperationProvider();",
        "createCloudflareWorkspaceJobResponse<WorkspaceJobObservabilityProjection>();",
        "createCloudflareLedgerAgUiSseResponse;",
        "createCloudflareLedgerAgUiHistorySseResponse;",
        "options.workspaceResolver",
        ".resolve({});",
        "options.readProjection();",
      ].join("\n"),
    );
    writeFixture(root, files.index, 'export * from "./workspace-job-profile";');
    writeFixture(
      root,
      files.fixture,
      "installCloudflareWorkspaceJobProfile(); export const fixtureWorkspaceJobProfile = true;",
    );
    writeFixture(
      root,
      files.test,
      [
        "installs a workspace-job profile over sanitized projection and existing host helpers",
        "failedObservabilityProjection();",
        'expect(JSON.stringify(body)).not.toContain("submitRunId");',
        "profile.createAgUiHistorySseResponse();",
        "profile.workspaceOperations.eventHandlers();",
      ].join("\n"),
    );
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`cloudflare workspace-job profile positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      files.profile,
      [
        "import type { WorkspaceJobProjection } from '@agent-os/workspace-job';",
        "const failure = { category: 'provider_failure' };",
        "projectWorkspaceJob(events, runId);",
      ].join("\n"),
    );
    const rejected = collectFailures(root);
    if (
      !rejected.some((failure) => failure.includes("raw workspace-job projection")) ||
      !rejected.some((failure) => failure.includes("failure taxonomy"))
    ) {
      return [
        `cloudflare workspace-job profile mutation was not rejected: ${JSON.stringify(rejected)}`,
      ];
    }
    return [];
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const failures = process.argv.includes("--self-test")
  ? collectSelfTestFailures()
  : collectFailures(repoRoot);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(
  process.argv.includes("--self-test")
    ? "cloudflare workspace-job profile self-test passed"
    : "cloudflare workspace-job profile passed",
);
