#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const eventsPath = "packages/carriers/decision-gate/src/events.ts";
const testPath = "packages/carriers/decision-gate/test/decision-gate.test.ts";

const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

const projectDecisionGateSource = (source) => {
  const marker = "export const projectDecisionGate =";
  const start = source.indexOf(marker);
  return start === -1 ? "" : source.slice(start);
};

const collectFailures = (root = repoRoot) => {
  const failures = [];
  const eventsSource = read(root, eventsPath);
  const testSource = read(root, testPath);
  const projectionSource = projectDecisionGateSource(eventsSource);

  if (projectionSource.length === 0) {
    failures.push(`${eventsPath}: missing projectDecisionGate`);
    return failures;
  }

  if (
    !eventsSource.includes("const isTerminalLifecycle =") ||
    !eventsSource.includes('consumed !== undefined || decision?.decision === "rejected"')
  ) {
    failures.push(`${eventsPath}: missing consumed/rejected terminal lifecycle predicate`);
  }
  if (
    !/if\s*\(\s*isTerminalLifecycle\(decision,\s*consumed\)\s*\)\s*continue;/.test(projectionSource)
  ) {
    failures.push(`${eventsPath}: projection does not absorb terminal lifecycle facts`);
  }
  if (!/next !== undefined && request === undefined/.test(projectionSource)) {
    failures.push(`${eventsPath}: requested facts are not first-fact wins`);
  }
  if (
    !/next !== undefined && request !== undefined && decision === undefined/.test(projectionSource)
  ) {
    failures.push(`${eventsPath}: decided facts are not first-fact wins after request`);
  }
  if (/\b(?:decision|consumed)\s*=\s*undefined\s*;/.test(projectionSource)) {
    failures.push(
      `${eventsPath}: projection clears lifecycle state instead of folding monotonically`,
    );
  }
  if (!/keeps a consumed gate terminal across later requested and decided facts/.test(testSource)) {
    failures.push(`${testPath}: missing consumed terminal lifecycle regression`);
  }
  if (!/keeps a rejected gate terminal across later requested and decided facts/.test(testSource)) {
    failures.push(`${testPath}: missing rejected terminal lifecycle regression`);
  }

  return failures;
};

const writeFixture = (root, relativePath, source) => {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
};

const validEventsFixture = `const isTerminalLifecycle = (
  decision,
  consumed,
) => consumed !== undefined || decision?.decision === "rejected";

export const projectDecisionGate = () => {
  let request;
  let decision;
  let consumed;
  for (const event of events) {
    if (isTerminalLifecycle(decision, consumed)) continue;
    switch (event.kind) {
      case DECISION_GATE_KIND.REQUESTED: {
        const next = requestedFrom(event.payload);
        if (next !== undefined && request === undefined) {
          request = next;
        }
        break;
      }
      case DECISION_GATE_KIND.DECIDED: {
        const next = decidedFrom(event.payload);
        if (next !== undefined && request !== undefined && decision === undefined) {
          decision = next;
        }
        break;
      }
    }
  }
};
`;

const validTestFixture = `
it("keeps a consumed gate terminal across later requested and decided facts", () => {});
it("keeps a rejected gate terminal across later requested and decided facts", () => {});
`;

const collectSelfTestFailures = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentos-decision-gate-lifecycle-"));
  try {
    writeFixture(root, eventsPath, validEventsFixture);
    writeFixture(root, testPath, validTestFixture);
    const baseline = collectFailures(root);
    if (baseline.length > 0) {
      return [`decision-gate lifecycle positive fixture failed:\n${baseline.join("\n")}`];
    }

    writeFixture(
      root,
      eventsPath,
      validEventsFixture.replace(
        "if (isTerminalLifecycle(decision, consumed)) continue;",
        "if (false) continue;",
      ),
    );
    const missingTerminal = collectFailures(root);
    if (!missingTerminal.some((failure) => failure.includes("absorb terminal"))) {
      return [
        `decision-gate lifecycle terminal mutation was not rejected: ${JSON.stringify(
          missingTerminal,
        )}`,
      ];
    }

    writeFixture(root, eventsPath, validEventsFixture.replace(" && request === undefined", ""));
    const mutableRequest = collectFailures(root);
    if (!mutableRequest.some((failure) => failure.includes("requested facts"))) {
      return [
        `decision-gate lifecycle request mutation was not rejected: ${JSON.stringify(
          mutableRequest,
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
    ? "decision-gate lifecycle boundary self-test passed"
    : "decision-gate lifecycle boundary passed",
);
