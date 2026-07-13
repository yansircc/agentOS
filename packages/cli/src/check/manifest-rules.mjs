const allowedEngines = new Set(["generatedProjection", "proofClass", "algorithmic"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const assertProofClasses = (ruleId, proofClasses) => {
  if (!stringArray(proofClasses) || proofClasses.length === 0) {
    throw new Error(`${ruleId}: proofClass acceptance requires non-empty proofClasses`);
  }
};

export const validateRuleAcceptance = (rule, failures) => {
  if (!isRecord(rule.acceptance)) {
    failures.push(`${rule.id}: missing acceptance`);
    return;
  }
  if (!allowedEngines.has(rule.acceptance.engine)) {
    failures.push(`${rule.id}: acceptance.engine must be one of ${[...allowedEngines].join(", ")}`);
  }
  if (rule.acceptance.engine === "proofClass") {
    try {
      assertProofClasses(rule.id, rule.acceptance.proofClasses);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (rule.acceptance.engine === "algorithmic") {
    if (typeof rule.acceptance.checker !== "string" || rule.acceptance.checker.length === 0) {
      failures.push(`${rule.id}: algorithmic acceptance requires checker`);
    }
    if (typeof rule.acceptance.reason !== "string" || rule.acceptance.reason.length === 0) {
      failures.push(`${rule.id}: algorithmic acceptance requires reason`);
    }
    if (rule.acceptance.packageCommands !== undefined) {
      failures.push(`${rule.id}: algorithmic acceptance must not execute packageCommands`);
    }
  }
  if (rule.acceptance.engine === "generatedProjection") {
    if (
      typeof rule.acceptance.command !== "string" ||
      !/\s--check(?:\s|$)/u.test(rule.acceptance.command)
    ) {
      failures.push(`${rule.id}: generatedProjection acceptance requires a --check command`);
    }
  }
};

export const runRuleAcceptance = async (rule, options = {}) => {
  const { runRegisteredProof } = await import("./proof-runner.mjs");
  return runRegisteredProof({ ...options, ruleId: rule.id });
};
