import assert from "node:assert/strict";
import test from "node:test";
import {
  coreClaimedNamespaceFindingsForSource,
  ownerIdDeclarationFindingsForSource,
  ownerIdRegistryFindings,
} from "../src/check/algorithmic-checks.mjs";

const workspacePackageNames = new Set([
  "@agent-os/core",
  "@agent-os/runtime",
  "@agent-os/workspace-op",
]);
const registeredOwners = new Map([
  [
    "@agent-os/runtime-protocol",
    {
      ownerId: "@agent-os/runtime-protocol",
      status: "active",
      sourcePackageNames: ["@agent-os/core"],
    },
  ],
  [
    "@agent-os/workspace-op",
    {
      ownerId: "@agent-os/workspace-op",
      status: "active",
      sourcePackageNames: ["@agent-os/workspace-op"],
    },
  ],
  [
    "@agent-os/image",
    {
      ownerId: "@agent-os/image",
      status: "retired",
      retiredSourcePackageNames: ["@agent-os/image"],
    },
  ],
]);

void test("owner-id registry rejects duplicate owners, non-workspace active sources, and live retired sources", () => {
  const findings = ownerIdRegistryFindings({
    workspacePackageNames,
    registry: {
      schemaVersion: 1,
      policy: {
        allocation: "append-only",
        retirement: "never reuse retired ids",
        namespaceSplit: "ownerId is not sourcePackageName",
      },
      owners: [
        {
          ownerId: "@agent-os/workspace-op",
          status: "active",
          sourcePackageNames: ["@agent-os/workspace-op"],
        },
        {
          ownerId: "@agent-os/workspace-op",
          status: "active",
          sourcePackageNames: ["@agent-os/missing"],
        },
        {
          ownerId: "@agent-os/image",
          status: "retired",
          sourcePackageNames: ["@agent-os/core"],
        },
      ],
    },
  });

  assert.deepEqual(findings, [
    "architecture/owner-ids.json:owners[1]: duplicate ownerId @agent-os/workspace-op",
    "architecture/owner-ids.json:owners[1]: sourcePackageName @agent-os/missing is not a workspace package",
    "architecture/owner-ids.json:owners[2]: retired owner must not declare live sourcePackageNames",
    "architecture/owner-ids.json:owners[2]: retiredSourcePackageNames must be a non-empty string array for retired owners",
  ]);
});

void test("owner-id declaration scanner rejects packageId and unregistered identity", () => {
  const findings = ownerIdDeclarationFindingsForSource({
    file: "packages/carriers/workspace-op/src/definition.ts",
    workspacePackageNames,
    registeredOwners,
    content: [
      "export const carrier = defineCarrier({",
      '  packageId: "@agent-os/workspace-op",',
      '  ownerId: "@agent-os/missing-owner",',
      '  sourcePackageName: "@agent-os/runtime",',
      '  prefix: "workspace_op.",',
      '  roles: ["reader"],',
      "  events: {},",
      "});",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    findings.map((finding) => finding.replace(/:\d+:\d+:/u, ":line:col:")),
    [
      "packages/carriers/workspace-op/src/definition.ts:line:col: owner-ids: defineCarrier declaration must not declare packageId",
      "packages/carriers/workspace-op/src/definition.ts:line:col: owner-ids: ownerId @agent-os/missing-owner is not registered in architecture/owner-ids.json",
    ],
  );
});

void test("owner-id declaration scanner rejects retired owners", () => {
  const findings = ownerIdDeclarationFindingsForSource({
    file: "packages/runtime/test/cloudflare/test-worker.ts",
    workspacePackageNames,
    registeredOwners,
    content: [
      "export const ExtensionTestDO = createAgentDurableObject({",
      "  extensions: () => [",
      "    eventNamespace({",
      '      ownerId: "@agent-os/image",',
      '      sourcePackageName: "@agent-os/runtime",',
      '      kindPrefixes: ["image."],',
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    findings.map((finding) => finding.replace(/:\d+:\d+:/u, ":line:col:")),
    [
      "packages/runtime/test/cloudflare/test-worker.ts:line:col: owner-ids: ownerId @agent-os/image is retired and cannot be declared",
    ],
  );
});

void test("core claimed namespace scanner rejects stale package metadata", () => {
  const findings = coreClaimedNamespaceFindingsForSource({
    file: "packages/core/src/errors.ts",
    workspacePackageNames,
    registeredOwners,
    content: [
      "export const CORE_CLAIMED_EVENT_NAMESPACES = [",
      "  {",
      '    ownerId: "@agent-os/runtime-protocol",',
      '    sourcePackageName: "@agent-os/runtime-protocol",',
      '    packageId: "@agent-os/runtime-protocol",',
      '    kindPrefixes: ["runtime."],',
      "  },",
      "] as const;",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    findings.map((finding) => finding.replace(/:\d+:\d+:/u, ":line:col:")),
    [
      "packages/core/src/errors.ts:line:col: owner-ids: CORE_CLAIMED_EVENT_NAMESPACES must not declare packageId",
      "packages/core/src/errors.ts:line:col: owner-ids: sourcePackageName @agent-os/runtime-protocol is not a workspace package",
    ],
  );
});

void test("owner-id declaration scanner rejects source packages outside the registered owner", () => {
  const findings = ownerIdDeclarationFindingsForSource({
    file: "packages/carriers/workspace-op/src/definition.ts",
    workspacePackageNames,
    registeredOwners,
    content: [
      "export const carrier = defineCarrier({",
      '  ownerId: "@agent-os/workspace-op",',
      '  sourcePackageName: "@agent-os/runtime",',
      '  prefix: "workspace_op.",',
      '  roles: ["reader"],',
      "  events: {},",
      "});",
      "",
    ].join("\n"),
  });

  assert.deepEqual(
    findings.map((finding) => finding.replace(/:\d+:\d+:/u, ":line:col:")),
    [
      "packages/carriers/workspace-op/src/definition.ts:line:col: owner-ids: sourcePackageName @agent-os/runtime is not registered for ownerId @agent-os/workspace-op",
    ],
  );
});
