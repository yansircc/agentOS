#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

const requiredSourceTerms = [
  {
    file: "packages/runtime-protocol/src/intent.ts",
    terms: [
      "export interface AgentIntent",
      '"agent.intent.submitted"',
      "validateIntentSettlementVocabulary",
    ],
  },
  {
    file: "packages/kernel/src/tools.ts",
    terms: ["export const defineProductTool", "pureToolExecution"],
  },
  {
    file: "packages/carriers/decision-gate/src/definition.ts",
    terms: [
      'kind: "requested"',
      'kind: "decided"',
      'kind: "consumed"',
      "claim: pre",
      "claim: lived",
    ],
  },
  {
    file: "packages/carriers/decision-gate/src/settlement.ts",
    terms: [
      "settleDecisionGateConsumed",
      'symbolicSettlementRef("decision_gate"',
      "admitDecisionGate",
    ],
  },
  {
    file: "packages/backends/protocol/src/index.ts",
    terms: [
      "dispatchReceiptBeforeTerminalProof",
      "dispatchFailedHasNoDeliveryReceipt",
      "idempotencyKey",
      "deliveryReceipt",
      '"external_receipt"',
    ],
  },
];

const forbiddenToolWriterTokens = [
  /\bLedger\b/,
  /\bBoundaryEvents\b/,
  /\bDispatchTargetAdapter\b/,
  /\bScheduler\b/,
  /\bcommit\s*\(/,
  /\bappend\s*\(/,
  /\binsertEvent\s*\(/,
];

const baselineGoldenFlow = [
  {
    phase: "tool_intent",
    actor: "tool",
    eventKind: "agent.intent.submitted",
    intentRef: "intent/example-surface-edit/1",
    payload: {
      productCarrierRef: "example_product.surface_edit",
      operation: "request_edit",
    },
  },
  {
    phase: "carrier_settlement",
    actor: "carrier",
    eventKind: "example_product.surface_edit.candidate_lived",
    claimRef: "claim/example-surface-edit/1",
    settlesIntentRef: "intent/example-surface-edit/1",
  },
  {
    phase: "decision_gate_consumed",
    actor: "carrier",
    eventKind: "decision_gate.consumed",
    claimRef: "claim/example-surface-edit/1",
    gateRef: "gate/example-surface-edit/1",
    decisionRef: "decision/example-surface-edit/1",
  },
  {
    phase: "dispatch_terminal",
    actor: "dispatch",
    eventKind: "dispatch.outbound.delivered",
    idempotencyKey: "apply/example-surface-edit/1",
    deliveryReceipt: {
      anchorKind: "external_receipt",
      anchorId: "dispatch:apply/example-surface-edit/1",
    },
  },
];

const sourceTermFailures = (root) => {
  const failures = [];
  for (const requirement of requiredSourceTerms) {
    const source = read(root, requirement.file);
    for (const term of requirement.terms) {
      if (!source.includes(term)) {
        failures.push(`${requirement.file}: missing backend-neutral mutation source term ${term}`);
      }
    }
  }

  const toolsSource = read(root, "packages/kernel/src/tools.ts");
  for (const pattern of forbiddenToolWriterTokens) {
    const match = toolsSource.match(pattern);
    if (match !== null) {
      failures.push(
        `packages/kernel/src/tools.ts: tool mutation boundary leaks writer token ${match[0]}`,
      );
    }
  }
  return failures;
};

const indexByPhase = (flow) => {
  const phases = new Map();
  flow.forEach((step, index) => phases.set(step.phase, { step, index }));
  return phases;
};

const isMutationTerminal = (kind) =>
  /(?:candidate|apply)_(?:lived|rejected)$/.test(kind) ||
  kind === "decision_gate.consumed" ||
  kind.startsWith("dispatch.outbound.");

const validateGoldenFlow = (flow) => {
  const failures = [];
  const phases = indexByPhase(flow);
  const requirePhase = (phase) => {
    const entry = phases.get(phase);
    if (entry === undefined) failures.push(`golden missing phase ${phase}`);
    return entry;
  };

  const intent = requirePhase("tool_intent");
  const settlement = requirePhase("carrier_settlement");
  const decision = requirePhase("decision_gate_consumed");
  const terminal = requirePhase("dispatch_terminal");

  for (const entry of [intent, settlement, decision, terminal]) {
    if (entry === undefined) return failures;
  }

  if (intent.step.actor !== "tool" || !intent.step.eventKind.startsWith("agent.intent.")) {
    failures.push("tool/UI input must emit typed Intent only");
  }

  for (const step of flow) {
    if (step.actor === "tool" && isMutationTerminal(step.eventKind)) {
      failures.push(`tool emitted mutation lifecycle fact ${step.eventKind}`);
    }
  }

  if (settlement.index <= intent.index) {
    failures.push("carrier settlement must follow typed intent");
  }
  if (settlement.step.actor !== "carrier") {
    failures.push("candidate lifecycle must be carrier settlement");
  }
  if (settlement.step.settlesIntentRef !== intent.step.intentRef) {
    failures.push("carrier settlement must settle the typed intent ref");
  }
  if (settlement.step.eventKind.startsWith("agent.intent.")) {
    failures.push("carrier settlement kind must be disjoint from intent kind");
  }

  if (decision.index <= settlement.index) {
    failures.push("decision-gate consumption must follow carrier settlement");
  }
  if (decision.step.eventKind !== "decision_gate.consumed") {
    failures.push("decision gate must consume the settled carrier claim");
  }
  if (decision.step.claimRef !== settlement.step.claimRef) {
    failures.push("decision gate must consume the carrier settlement claim");
  }

  if (terminal.index <= decision.index) {
    failures.push("dispatch terminal fact must follow decision consumption");
  }
  if (terminal.step.eventKind !== "dispatch.outbound.delivered") {
    failures.push("external apply terminal fact must be dispatch receipt-owned");
  }
  if (
    typeof terminal.step.idempotencyKey !== "string" ||
    terminal.step.idempotencyKey.length === 0
  ) {
    failures.push("dispatch receipt terminal fact must carry idempotencyKey");
  }
  if (terminal.step.deliveryReceipt?.anchorKind !== "external_receipt") {
    failures.push("dispatch terminal fact must be backed by external delivery receipt");
  }

  return failures;
};

const goldenFlowFromFixture = (root) => {
  const file = path.join(root, "test", "backend-neutral-mutation-golden.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      failure: `test/backend-neutral-mutation-golden.json: cannot read backend-neutral mutation golden fixture: ${error.message}`,
    };
  }
};

const collectFailures = (root = repoRoot) => {
  const failures = [...sourceTermFailures(root)];
  const fixture = goldenFlowFromFixture(root);
  if (!fixture.ok) {
    failures.push(fixture.failure);
  } else if (!Array.isArray(fixture.value)) {
    failures.push("test/backend-neutral-mutation-golden.json: golden fixture must be an array");
  } else {
    failures.push(...validateGoldenFlow(fixture.value));
  }
  return failures;
};

const writeFixture = (root, rel, source) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const writeSourceFixture = (root) => {
  for (const requirement of requiredSourceTerms) {
    writeFixture(root, requirement.file, requirement.terms.join("\n"));
  }
};

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-mutation-golden-"));
  try {
    writeSourceFixture(root);
    const sourceBaseline = sourceTermFailures(root);
    if (sourceBaseline.length > 0) {
      return [
        `backend-neutral mutation source positive fixture failed:\n${sourceBaseline.join("\n")}`,
      ];
    }

    writeFixture(root, "packages/backends/protocol/src/index.ts", "idempotencyKey\n");
    const missingReceipt = sourceTermFailures(root);
    if (!missingReceipt.some((failure) => failure.includes("deliveryReceipt"))) {
      return [
        `backend-neutral mutation source mutation was not rejected: ${JSON.stringify(
          missingReceipt,
        )}`,
      ];
    }

    const flowBaseline = validateGoldenFlow(baselineGoldenFlow);
    if (flowBaseline.length > 0) {
      return [
        `backend-neutral mutation golden positive fixture failed:\n${flowBaseline.join("\n")}`,
      ];
    }

    const directToolMutation = [
      { phase: "tool_intent", actor: "tool", eventKind: "example.apply_lived" },
      ...baselineGoldenFlow.slice(1),
    ];
    const directMutationFailures = validateGoldenFlow(directToolMutation);
    if (!directMutationFailures.some((failure) => failure.includes("tool emitted mutation"))) {
      return [
        `backend-neutral mutation direct-tool mutation was not rejected: ${JSON.stringify(
          directMutationFailures,
        )}`,
      ];
    }

    const missingReceiptFlow = baselineGoldenFlow.map((step) =>
      step.phase === "dispatch_terminal" ? { ...step, deliveryReceipt: undefined } : step,
    );
    const missingReceiptFailures = validateGoldenFlow(missingReceiptFlow);
    if (!missingReceiptFailures.some((failure) => failure.includes("delivery receipt"))) {
      return [
        `backend-neutral mutation missing receipt was not rejected: ${JSON.stringify(
          missingReceiptFailures,
        )}`,
      ];
    }

    const wrongOrder = [
      baselineGoldenFlow[0],
      baselineGoldenFlow[2],
      baselineGoldenFlow[1],
      baselineGoldenFlow[3],
    ];
    const wrongOrderFailures = validateGoldenFlow(wrongOrder);
    if (!wrongOrderFailures.some((failure) => failure.includes("decision-gate consumption"))) {
      return [
        `backend-neutral mutation order mutation was not rejected: ${JSON.stringify(
          wrongOrderFailures,
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
    ? "backend-neutral mutation golden self-test passed"
    : "backend-neutral mutation golden passed",
);
