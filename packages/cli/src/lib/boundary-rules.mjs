import fs from "node:fs";
import path from "node:path";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const readBoundaryRulesSource = (root, failures = []) => {
  const file = "docs/agent/boundary-rules.source.json";
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    if (!isRecord(value)) {
      failures.push(`${file}: boundary rules source must be an object`);
      return null;
    }
    return value;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    failures.push(`${file}: unable to read boundary rules source: ${reason}`);
    return null;
  }
};

export const commandGroupContainsRule = (source, groupId, ruleId, seen = new Set()) => {
  if (!isRecord(source.commandGroups) || seen.has(groupId)) return false;
  const steps = source.commandGroups[groupId];
  if (!Array.isArray(steps)) return false;
  seen.add(groupId);
  return steps.some((step) => {
    if (!isRecord(step)) return false;
    if (step.type === "rule") return step.id === ruleId;
    if (step.type === "group" && typeof step.id === "string") {
      return commandGroupContainsRule(source, step.id, ruleId, seen);
    }
    return false;
  });
};

export const collectBoundaryRuleMembershipFailures = (root, specs) => {
  const failures = [];
  const source = readBoundaryRulesSource(root, failures);
  if (source === null) return failures;

  const rules = Array.isArray(source.rules) ? source.rules : [];
  for (const spec of specs) {
    const rule = rules.find((entry) => isRecord(entry) && entry.id === spec.ruleId);
    if (rule === undefined) {
      failures.push(`docs/agent/boundary-rules.source.json: missing boundary rule ${spec.ruleId}`);
      continue;
    }
    if (spec.commandGroup !== undefined && rule.commandGroup !== spec.commandGroup) {
      failures.push(
        `docs/agent/boundary-rules.source.json: ${spec.ruleId} must declare commandGroup ${spec.commandGroup}`,
      );
    }
    for (const groupId of spec.reachableFrom ?? []) {
      if (!commandGroupContainsRule(source, groupId, spec.ruleId)) {
        failures.push(
          `docs/agent/boundary-rules.source.json: ${groupId} must include boundary rule ${spec.ruleId}`,
        );
      }
    }
  }
  return failures;
};
