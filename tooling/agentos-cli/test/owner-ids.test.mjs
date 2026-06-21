import assert from "node:assert/strict";
import test from "node:test";
import {
  ownerIdDeclarationFindingsForSource,
  ownerIdRegistryFindings,
} from "../src/check/algorithmic-checks.mjs";

const workspacePackageNames = new Set(["@agent-os/runtime", "@agent-os/workspace-op"]);
const registeredOwners = new Map([
  [
    "@agent-os/workspace-op",
    {
      ownerId: "@agent-os/workspace-op",
      status: "active",
      sourcePackageNames: ["@agent-os/workspace-op"],
    },
  ],
]);

void test("owner-id registry rejects duplicate owners and non-workspace sources", () => {
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
      ],
    },
  });

  assert.deepEqual(findings, [
    "architecture/owner-ids.json:owners[1]: duplicate ownerId @agent-os/workspace-op",
    "architecture/owner-ids.json:owners[1]: sourcePackageName @agent-os/missing is not a workspace package",
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
