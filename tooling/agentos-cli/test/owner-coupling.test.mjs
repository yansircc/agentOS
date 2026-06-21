import assert from "node:assert/strict";
import test from "node:test";
import { ownerCouplingFindingsForSource } from "../src/check/algorithmic-checks.mjs";

const packageNames = {
  sourcePackageNames: new Set(["@agent-os/runtime", "@agent-os/workspace-op"]),
  publicPackageNames: new Set(["@yansirplus/runtime"]),
};

void test("owner-coupling scanner reports package metadata entering identity sinks", () => {
  const findings = ownerCouplingFindingsForSource(
    [
      "const carrier = {",
      '  packageId: "@agent-os/runtime",',
      "  settlementId: spec.packageId,",
      "  factOwnerRef: contract.packageId,",
      "  owner: namespace.packageId,",
      "};",
      "if (committed.factOwnerRef !== contract.packageId) {}",
      "",
    ].join("\n"),
    "fixture.ts",
    packageNames,
  );

  assert.deepEqual(
    findings.map((finding) => [finding.sink, finding.source]),
    [
      ["packageId", "sourcePackageNameLiteral"],
      ["settlementId", "packageId"],
      ["factOwnerRef", "packageId"],
      ["owner", "packageId"],
      ["factOwnerRef", "packageId"],
    ],
  );
});

void test("owner-coupling scanner ignores package metadata outside identity sinks", () => {
  const findings = ownerCouplingFindingsForSource(
    [
      "const distribution = {",
      "  name: publicPackageName(record.packageJson.name),",
      "  sourcePackageName: record.packageJson.name,",
      "};",
      'const label = "@agent-os/runtime";',
      "",
    ].join("\n"),
    "fixture.ts",
    packageNames,
  );

  assert.deepEqual(findings, []);
});
