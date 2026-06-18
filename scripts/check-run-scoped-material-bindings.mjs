#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const requirePattern = (failures, root, file, pattern, message) => {
  if (!pattern.test(read(root, file))) failures.push(`${file}: ${message}`);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];

  requirePattern(
    failures,
    root,
    "packages/runtime-protocol/src/bindings.ts",
    /import type \{ MaterialRef \} from "@agent-os\/kernel\/material-ref";/,
    "AgentBindings must import MaterialRef",
  );
  requirePattern(
    failures,
    root,
    "packages/runtime-protocol/src/bindings.ts",
    /readonly materials\?: Readonly<Record<string, MaterialRef>>/,
    "submit bindings must carry symbolic MaterialRef values, not unknown provider material",
  );
  requirePattern(
    failures,
    root,
    "packages/runtime-protocol/src/submit.ts",
    /materials: \{ \.\.\.spec\.bindings\.materials, \.\.\.spec\.input\.materials \}/,
    "lowerSubmitRunInput must merge framework and run-scoped symbolic MaterialRef values into SubmitSpec.materials",
  );
  requirePattern(
    failures,
    root,
    "packages/backends/cloudflare-do/src/agent-do.ts",
    /\.\.\.\(spec\.materials === undefined \? \{\} : \{ materials: spec\.materials \}\)/,
    "submitWithBindings must preserve run-scoped MaterialRef values in SubmitRunInput.materials",
  );
  requirePattern(
    failures,
    root,
    "packages/backends/cloudflare-do/src/agent-do.ts",
    /lowerSubmitRunInput\(\{[\s\S]*?input: runInput,[\s\S]*?bindings: \{[\s\S]*?\.\.\.baseBindings/s,
    "submitWithBindings must lower run input with framework-owned submit bindings",
  );
  requirePattern(
    failures,
    root,
    "packages/runtime/src/submit-agent.ts",
    /isMaterialRef,\s*materialRefKey,\s*materialRefSatisfiesRequirement/s,
    "runtime submit material resolution must import isMaterialRef",
  );
  requirePattern(
    failures,
    root,
    "packages/runtime/src/submit-agent.ts",
    /if \(!isMaterialRef\(ref\)\) \{[\s\S]*?material_invalid:\$\{requirement\.slot\}[\s\S]*?validation_failed/s,
    "runtime submit material resolution must reject non-symbolic material values before resolver lookup",
  );
  requirePattern(
    failures,
    root,
    "packages/runtime/src/tool-settlement.ts",
    /rejectionKinds: \[[^\]]*"validation_failed"[^\]]*\]/,
    "tool settlement vocabulary must admit validation_failed material-axis rejections",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/src/tools.ts",
    /readonly broker\?: ExecutionDomainMaterialBrokerCapability/,
    "ExecutionDomainDeclaration must own the optional MaterialRef broker capability",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/src/tools.ts",
    /duplicate_material_broker_declaration/,
    "ExecutionDomainRegistry must reject duplicate per-domain broker declarations",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/src/tools.ts",
    /export const planMaterialBrokerSubstitution =/,
    "kernel must expose one fail-closed MaterialRef broker planning helper",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/src/tools.ts",
    /materialRefSatisfiesRequirement\(spec\.materialRef, spec\.requirement\)/,
    "broker planning must enforce MaterialRequirement before substitution",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/test/tools.test.ts",
    /missing_broker_declaration/,
    "kernel tests must cover missing broker declaration",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/test/tools.test.ts",
    /unsupported_material_kind/,
    "kernel tests must cover unsupported broker material kind",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/test/tools.test.ts",
    /requirement_mismatch/,
    "kernel tests must cover broker requirement mismatch",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/test/tools.test.ts",
    /isMaterialBrokerPlaceholder\(result\.plan\.placeholder\.value\)\)\.toBe\(false\)/,
    "kernel tests must prove placeholder strings are not accepted as broker placeholders",
  );
  requirePattern(
    failures,
    root,
    "packages/kernel/test/tools.test.ts",
    /JSON\.stringify\(result\.plan\.receipt\)\)\.not\.toContain\("resolved-secret-value"\)/,
    "kernel tests must prove broker receipts do not contain live bytes",
  );
  requirePattern(
    failures,
    root,
    "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
    /materials: \{ facade_token: tokenRef \}/,
    "facade submit worker test must prove run-scoped MaterialRef binding",
  );
  requirePattern(
    failures,
    root,
    "packages/backends/cloudflare-do/test/facade-types.ts",
    /@ts-expect-error submit materials carry symbolic MaterialRef values[\s\S]*?materials: \{ facade_token: "resolved-provider-material" \}/,
    "facade type fixture must reject resolved provider material in submit bindings",
  );
  requirePattern(
    failures,
    root,
    "packages/runtime/test/submit-agent-runtime-events.test.ts",
    /rejects non-symbolic material values before resolver lookup/,
    "runtime test must cover malformed material rejection",
  );

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const fixtureFiles = [
  "packages/runtime-protocol/src/bindings.ts",
  "packages/runtime-protocol/src/submit.ts",
  "packages/backends/cloudflare-do/src/agent-do.ts",
  "packages/runtime/src/submit-agent.ts",
  "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
  "packages/backends/cloudflare-do/test/facade-types.ts",
  "packages/runtime/test/submit-agent-runtime-events.test.ts",
  "packages/runtime/src/tool-settlement.ts",
  "packages/kernel/src/tools.ts",
  "packages/kernel/test/tools.test.ts",
];

const positiveFixtures = {
  "packages/runtime-protocol/src/bindings.ts": `
import type { MaterialRef } from "@agent-os/kernel/material-ref";
export interface AgentBindings { readonly materials?: Readonly<Record<string, MaterialRef>>; }
`,
  "packages/backends/cloudflare-do/src/agent-do.ts": `
export class AgentDurableObject {
  protected submitWithBindings(spec, baseBindings) {
    const runInput = {
      ...(spec.materials === undefined ? {} : { materials: spec.materials }),
    };
    return this.submitFull(lowerSubmitRunInput({
      input: runInput,
      bindings: { ...baseBindings },
    }));
  }
}
`,
  "packages/runtime-protocol/src/submit.ts": `
export const lowerSubmitRunInput = (spec) => ({
  materials: { ...spec.bindings.materials, ...spec.input.materials },
});
`,
  "packages/runtime/src/submit-agent.ts": `
import { isMaterialRef, materialRefKey, materialRefSatisfiesRequirement } from "@agent-os/kernel/material-ref";
const resolve = (ref, requirement) => {
  if (!isMaterialRef(ref)) {
    return materialRejection(claim, \`material_invalid:\${requirement.slot}\`, "validation_failed");
  }
  return materialRefSatisfiesRequirement(ref, requirement) ? materialRefKey(ref) : null;
};
`,
  "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts": `
defineAgentSubmitBindings({ materials: { facade_token: tokenRef } });
`,
  "packages/backends/cloudflare-do/test/facade-types.ts": `
defineAgentSubmitBindings({
  // @ts-expect-error submit materials carry symbolic MaterialRef values
  materials: { facade_token: "resolved-provider-material" },
});
`,
  "packages/runtime/test/submit-agent-runtime-events.test.ts": `
it.effect("rejects non-symbolic material values before resolver lookup", () => {});
`,
  "packages/runtime/src/tool-settlement.ts": `
export const toolSettlementContract = {
  rejectionKinds: ["policy_denied", "provider_rejected", "resource_denied", "validation_failed"],
};
`,
  "packages/kernel/src/tools.ts": `
export interface ExecutionDomainDeclaration {
  readonly broker?: ExecutionDomainMaterialBrokerCapability;
}
export const duplicate = "duplicate_material_broker_declaration";
export const planMaterialBrokerSubstitution = (spec) => {
  if (!materialRefSatisfiesRequirement(spec.materialRef, spec.requirement)) return { ok: false };
};
`,
  "packages/kernel/test/tools.test.ts": `
expect(planMaterialBrokerSubstitution({})).toEqual({ issues: [{ kind: "missing_broker_declaration" }] });
expect(planMaterialBrokerSubstitution({})).toEqual({ issues: [{ kind: "unsupported_material_kind" }] });
expect(planMaterialBrokerSubstitution({})).toEqual({ issues: [{ kind: "requirement_mismatch" }] });
expect(isMaterialBrokerPlaceholder(result.plan.placeholder.value)).toBe(false);
expect(JSON.stringify(result.plan.receipt)).not.toContain("resolved-secret-value");
`,
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-run-material-bindings-"));
  try {
    for (const file of fixtureFiles) writeFixture(root, file, positiveFixtures[file]);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`run-scoped material bindings positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      "packages/runtime-protocol/src/bindings.ts",
      "export interface AgentBindings { readonly materials?: Readonly<Record<string, unknown>>; }\n",
    );
    const unknownBindingFailures = collectFailures(root);
    if (
      !unknownBindingFailures.some((failure) =>
        failure.includes("submit bindings must carry symbolic MaterialRef values"),
      )
    ) {
      return [
        `run-scoped material bindings mutation fixture was not rejected: ${JSON.stringify(
          unknownBindingFailures,
        )}`,
      ];
    }

    for (const file of fixtureFiles) writeFixture(root, file, positiveFixtures[file]);
    writeFixture(
      root,
      "packages/runtime/src/submit-agent.ts",
      'import { materialRefKey, materialRefSatisfiesRequirement } from "@agent-os/kernel/material-ref";\n',
    );
    const runtimeGuardFailures = collectFailures(root);
    if (
      !runtimeGuardFailures.some((failure) =>
        failure.includes("must reject non-symbolic material values"),
      )
    ) {
      return [
        `run-scoped runtime material mutation fixture was not rejected: ${JSON.stringify(
          runtimeGuardFailures,
        )}`,
      ];
    }

    for (const file of fixtureFiles) writeFixture(root, file, positiveFixtures[file]);
    writeFixture(
      root,
      "packages/runtime/src/tool-settlement.ts",
      'export const toolSettlementContract = { rejectionKinds: ["policy_denied", "provider_rejected", "resource_denied"] };\n',
    );
    const settlementFailures = collectFailures(root);
    if (
      !settlementFailures.some((failure) =>
        failure.includes("must admit validation_failed material-axis rejections"),
      )
    ) {
      return [
        `run-scoped material settlement mutation fixture was not rejected: ${JSON.stringify(
          settlementFailures,
        )}`,
      ];
    }

    for (const file of fixtureFiles) writeFixture(root, file, positiveFixtures[file]);
    writeFixture(
      root,
      "packages/kernel/src/tools.ts",
      "export const planMaterialBrokerSubstitution = () => ({ ok: true });\n",
    );
    const brokerFailures = collectFailures(root);
    if (
      !brokerFailures.some((failure) =>
        failure.includes("ExecutionDomainDeclaration must own the optional MaterialRef broker"),
      )
    ) {
      return [
        `run-scoped broker mutation fixture was not rejected: ${JSON.stringify(brokerFailures)}`,
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
    ? "run-scoped material bindings self-test passed"
    : "run-scoped material bindings passed",
);
