#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const forbiddenTokens = [
  "\\bLedger\\b",
  "\\bBoundaryEvents\\b",
  "\\bLedgerCommitEventSpec\\b",
  "\\bDispatchTargetAdapter\\b",
  "\\bScheduler\\b",
  "\\bcommit\\s*\\(",
  "\\bappend\\s*\\(",
  "\\binsertEvent\\s*\\(",
];

const forbiddenMutationTokens = [
  "candidate_lived",
  "candidate_rejected",
  "apply_lived",
  "apply_rejected",
  ["mutation", "proposed"].join("."),
  ["mutation", "settled"].join("."),
  ["state", "transitioned"].join("."),
  ["entity", "updated"].join("."),
];

const regexForToken = (token) => new RegExp(token, "g");

const lineNumber = (source, index) => source.slice(0, index).split("\n").length;

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

const blockFrom = (source, start) => {
  const index = source.indexOf(start);
  if (index === -1) return null;
  const nextExport = source.indexOf("\nexport ", index + start.length);
  return nextExport === -1 ? source.slice(index) : source.slice(index, nextExport);
};

const requiredToolContracts = [
  {
    label: "ToolRequirements must be never",
    test: (source) => /export\s+type\s+ToolRequirements\s*=\s*never\s*;/u.test(source),
  },
  {
    label: "ToolEffect must depend on ToolRequirements",
    test: (source) =>
      /export\s+type\s+ToolEffect\s*<\s*R\s*>\s*=\s*Effect\.Effect\s*<\s*R\s*,\s*ToolError\s*,\s*ToolRequirements\s*>\s*;/u.test(
        source,
      ),
  },
  {
    label: "ToolAdmitter requirements must be never",
    test: (source) =>
      /export\s+type\s+ToolAdmitter[\s\S]*?Effect\.Effect\s*<\s*AdmitVerdict\s*,\s*ToolError\s*,\s*never\s*>/u.test(
        source,
      ),
  },
  {
    label: "ToolExecute must return ToolEffect",
    test: (source) =>
      /export\s+type\s+ToolExecute[\s\S]*?ctx:\s*ToolExecutionContext[\s\S]*?\)\s*=>\s*ToolEffect\s*<\s*R\s*>/u.test(
        source,
      ),
  },
];

const validateToolContractShape = (source, failures) => {
  for (const contract of requiredToolContracts) {
    if (!contract.test(source)) {
      failures.push(`packages/kernel/src/tools.ts: ${contract.label}`);
    }
  }

  const ctxBlock = blockFrom(source, "export interface ToolExecutionContext");
  if (ctxBlock === null) {
    failures.push("packages/kernel/src/tools.ts: missing ToolExecutionContext");
  } else {
    if (!ctxBlock.includes("readonly materials: ResolvedToolMaterials")) {
      failures.push("packages/kernel/src/tools.ts: ToolExecutionContext must expose materials");
    }
    for (const token of forbiddenTokens) {
      const pattern = regexForToken(token);
      for (const match of ctxBlock.matchAll(pattern)) {
        failures.push(
          `packages/kernel/src/tools.ts:${lineNumber(
            source,
            source.indexOf(ctxBlock) + (match.index ?? 0),
          )}: ToolExecutionContext leaks writer token ${match[0]}`,
        );
      }
    }
  }

  const executeToolBlock = blockFrom(source, "export const executeTool");
  if (executeToolBlock === null) {
    failures.push("packages/kernel/src/tools.ts: missing executeTool");
  } else if (
    !/tool\.execute\s*\(\s*args\s*,\s*\{\s*\.\.\.context\s*,\s*materials\s*\}\s*\)/u.test(
      executeToolBlock,
    )
  ) {
    failures.push(
      "packages/kernel/src/tools.ts: executeTool must let resolved materials override injected context",
    );
  }
};

const isMutationLifecycleKind = (kind) =>
  /(?:candidate|apply)_(?:lived|rejected)$/u.test(kind) ||
  kind === "decision_gate.consumed" ||
  kind.startsWith("dispatch.outbound.");

const validateMutationGolden = (root) => {
  const file = path.join(root, "test", "backend-neutral-mutation-golden.json");
  const failures = [];
  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return [
      `test/backend-neutral-mutation-golden.json: cannot read mutation golden: ${error.message}`,
    ];
  }
  if (!Array.isArray(flow)) {
    return ["test/backend-neutral-mutation-golden.json: golden fixture must be an array"];
  }

  const intentStep = flow.find((step) => step.phase === "tool_intent");
  if (intentStep === undefined) {
    failures.push("test/backend-neutral-mutation-golden.json: missing tool_intent phase");
  } else {
    if (intentStep.actor !== "tool") {
      failures.push("test/backend-neutral-mutation-golden.json: tool_intent actor must be tool");
    }
    if (
      typeof intentStep.eventKind !== "string" ||
      !intentStep.eventKind.startsWith("agent.intent.")
    ) {
      failures.push(
        "test/backend-neutral-mutation-golden.json: tool_intent must emit an agent intent kind",
      );
    }
  }

  for (const step of flow) {
    if (step.actor === "tool" && isMutationLifecycleKind(String(step.eventKind))) {
      failures.push(
        `test/backend-neutral-mutation-golden.json: tool emitted mutation lifecycle fact ${step.eventKind}`,
      );
    }
  }
  return failures;
};

const collectFailures = (root) => {
  const source = read(root, "packages/kernel/src/tools.ts");
  const failures = [];
  validateToolContractShape(source, failures);
  for (const token of forbiddenTokens) {
    const pattern = regexForToken(token);
    for (const match of source.matchAll(pattern)) {
      failures.push(
        `packages/kernel/src/tools.ts:${lineNumber(source, match.index ?? 0)}: forbidden tool mutation boundary token ${match[0]}`,
      );
    }
  }
  for (const token of forbiddenMutationTokens) {
    const index = source.indexOf(token);
    if (index !== -1) {
      failures.push(
        `packages/kernel/src/tools.ts:${lineNumber(
          source,
          index,
        )}: tool mutation lifecycle token ${token} belongs to carrier or dispatch settlement`,
      );
    }
  }
  failures.push(...validateMutationGolden(root));
  return failures;
};

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const positiveToolsSource = `import { Effect } from "effect";
import { ToolError } from "./errors";
import type { AdmitVerdict } from "./effect-claim";
import type { ResolvedMaterial } from "./ref-resolver";

export interface ToolExecutionContext {
  readonly materials: ResolvedToolMaterials;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type ResolvedToolMaterials = Readonly<Record<string, ResolvedMaterial>>;
export type ToolRequirements = never;
export type ToolEffect<R> = Effect.Effect<R, ToolError, ToolRequirements>;
export interface ToolAdmitInput<A = unknown> {
  readonly args: A;
}
export type ToolAdmitter<A = unknown> = (
  input: ToolAdmitInput<A>,
) => Effect.Effect<AdmitVerdict, ToolError, never>;
export type ToolExecute<A = unknown, R = unknown> = (
  args: A,
  ctx: ToolExecutionContext,
) => ToolEffect<R>;
export const executeTool = (tool, args, _toolName, materials = {}, context = {}) =>
  Effect.gen(function* () {
    const program = yield* Effect.try({ try: () => tool.execute(args, { ...context, materials }) });
    return yield* program;
  });
`;

const positiveGolden = [
  {
    phase: "tool_intent",
    actor: "tool",
    eventKind: "agent.intent.submitted",
    intentRef: "intent/example-surface-edit/1",
  },
  {
    phase: "carrier_settlement",
    actor: "carrier",
    eventKind: "example_product.surface_edit.candidate_lived",
  },
  {
    phase: "dispatch_terminal",
    actor: "dispatch",
    eventKind: "dispatch.outbound.delivered",
  },
];

const writePositiveFixture = (root) => {
  writeFixture(root, "packages/kernel/src/tools.ts", positiveToolsSource);
  writeFixture(root, "test/backend-neutral-mutation-golden.json", JSON.stringify(positiveGolden));
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-tool-boundary-"));
  try {
    writePositiveFixture(root);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`tool mutation boundary positive fixture failed:\n${baseline.join("\n")}`];
    }

    const cases = [
      {
        name: "writer requirement",
        file: "packages/kernel/src/tools.ts",
        source: positiveToolsSource.replace(
          "export type ToolRequirements = never;",
          "export interface ToolRequirements { readonly ledger: Ledger }",
        ),
        expected: "Ledger",
      },
      {
        name: "non-never requirement",
        file: "packages/kernel/src/tools.ts",
        source: positiveToolsSource.replace(
          "export type ToolRequirements = never;",
          "export type ToolRequirements = unknown;",
        ),
        expected: "ToolRequirements must be never",
      },
      {
        name: "effectful admitter",
        file: "packages/kernel/src/tools.ts",
        source: positiveToolsSource.replace(
          "Effect.Effect<AdmitVerdict, ToolError, never>",
          "Effect.Effect<AdmitVerdict, ToolError, Ledger>",
        ),
        expected: "ToolAdmitter requirements must be never",
      },
      {
        name: "execute context writer",
        file: "packages/kernel/src/tools.ts",
        source: positiveToolsSource.replace(
          "tool.execute(args, { ...context, materials })",
          "tool.execute(args, { ...context, materials, ledger })",
        ),
        expected: "executeTool must let resolved materials override injected context",
      },
      {
        name: "tool lifecycle fact",
        file: "packages/kernel/src/tools.ts",
        source: `${positiveToolsSource}\nexport const forbidden = "apply_lived";\n`,
        expected: "apply_lived",
      },
      {
        name: "golden direct tool mutation",
        file: "test/backend-neutral-mutation-golden.json",
        source: JSON.stringify([
          {
            phase: "tool_intent",
            actor: "tool",
            eventKind: "example_product.surface_edit.apply_lived",
          },
        ]),
        expected: "tool emitted mutation lifecycle fact",
      },
    ];

    const failures = [];
    for (const testCase of cases) {
      const target = path.join(root, testCase.file);
      const original = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, testCase.source);
      const rejected = collectFailures(root);
      if (!rejected.some((failure) => failure.includes(testCase.expected))) {
        failures.push(
          `${testCase.name}: mutation fixture was not rejected; failures=${JSON.stringify(
            rejected,
          )}`,
        );
      }
      fs.writeFileSync(target, original);
      const restored = collectFailures(root);
      if (restored.length > 0) {
        failures.push(`${testCase.name}: restored fixture failed:\n${restored.join("\n")}`);
      }
    }
    return failures;
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
    ? "tool mutation boundary self-test passed"
    : "tool mutation boundary passed",
);
