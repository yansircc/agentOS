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
    "packages/backends/cloudflare-do/src/agent-do.ts",
    /materials: \{ \.\.\.bindings\.materials \}/,
    "submitWithBindings must forward run-scoped material refs into SubmitSpec.materials",
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
    "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
    /materials: \{ facade_token: tokenRef \}/,
    "facade submit worker test must prove run-scoped MaterialRef binding",
  );
  requirePattern(
    failures,
    root,
    "packages/backends/cloudflare-do/test/facade-types.ts",
    /@ts-expect-error submit material bindings carry symbolic MaterialRef values[\s\S]*?materials: \{ facade_token: "resolved-provider-material" \}/,
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
  "packages/backends/cloudflare-do/src/agent-do.ts",
  "packages/runtime/src/submit-agent.ts",
  "packages/backends/cloudflare-do/test/facade-submit.worker.test.ts",
  "packages/backends/cloudflare-do/test/facade-types.ts",
  "packages/runtime/test/submit-agent-runtime-events.test.ts",
  "packages/runtime/src/tool-settlement.ts",
];

const positiveFixtures = {
  "packages/runtime-protocol/src/bindings.ts": `
import type { MaterialRef } from "@agent-os/kernel/material-ref";
export interface AgentBindings { readonly materials?: Readonly<Record<string, MaterialRef>>; }
`,
  "packages/backends/cloudflare-do/src/agent-do.ts": `
export class AgentDurableObject {
  protected submitWithBindings(spec, bindings) {
    return this.submitFull({ materials: { ...bindings.materials } });
  }
}
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
defineAgentSubmitBindings({ handlers: {}, materials: { facade_token: tokenRef } });
`,
  "packages/backends/cloudflare-do/test/facade-types.ts": `
defineAgentSubmitBindings({
  handlers: {},
  // @ts-expect-error submit material bindings carry symbolic MaterialRef values
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
