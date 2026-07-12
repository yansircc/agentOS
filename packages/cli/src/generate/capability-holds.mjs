const holdIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const contractRefPattern = /^contract:[a-z0-9]+(?:[./-][a-z0-9]+)*@1$/u;
const proofRefPattern = /^proof:[a-z0-9]+(?:[./-][a-z0-9]+)*$/u;

const exactKeys = (value, expected) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((key, index) => actual[index] === key);
};

const validateRefList = (value, pattern, label, failures) => {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`${label} must be a non-empty array`);
    return;
  }
  const seen = new Set();
  for (const ref of value) {
    if (typeof ref !== "string" || !pattern.test(ref)) {
      failures.push(`${label} has invalid ref ${String(ref)}`);
      continue;
    }
    if (seen.has(ref)) failures.push(`${label} has duplicate ref ${ref}`);
    seen.add(ref);
  }
};

export const validateCapabilityHolds = (holds) => {
  const failures = [];
  if (!Array.isArray(holds) || holds.length === 0) {
    return ["docs/surface.json: holds must be a non-empty array"];
  }
  const seen = new Set();
  for (const hold of holds) {
    const id = typeof hold?.id === "string" ? hold.id : "<unknown>";
    const label = `docs/surface.json: holds/${id}`;
    if (!exactKeys(hold, ["capability", "id", "promotion", "status", "summary"])) {
      failures.push(`${label} must contain exactly capability, id, promotion, status, summary`);
      continue;
    }
    if (!holdIdPattern.test(hold.id)) failures.push(`${label}: id must be kebab-case`);
    if (seen.has(hold.id)) failures.push(`${label}: duplicate hold id`);
    seen.add(hold.id);
    if (typeof hold.capability !== "string" || hold.capability.length === 0) {
      failures.push(`${label}: capability must be a non-empty string`);
    }
    if (hold.status !== "held") failures.push(`${label}: status must be held`);
    if (typeof hold.summary !== "string" || hold.summary.length === 0) {
      failures.push(`${label}: summary must be a non-empty string`);
    }
    if (!exactKeys(hold.promotion, ["missingContractRefs", "requiredProofRefs"])) {
      failures.push(
        `${label}/promotion must contain exactly missingContractRefs and requiredProofRefs`,
      );
      continue;
    }
    validateRefList(
      hold.promotion.missingContractRefs,
      contractRefPattern,
      `${label}/promotion/missingContractRefs`,
      failures,
    );
    validateRefList(
      hold.promotion.requiredProofRefs,
      proofRefPattern,
      `${label}/promotion/requiredProofRefs`,
      failures,
    );
  }
  return failures;
};

export const capabilityHoldRows = (holds) =>
  holds.map((hold) => [
    `\`${hold.id}\``,
    hold.capability,
    `\`${hold.status}\``,
    hold.promotion.missingContractRefs.map((ref) => `\`${ref}\``).join("<br>"),
    hold.promotion.requiredProofRefs.map((ref) => `\`${ref}\``).join("<br>"),
    hold.summary,
  ]);
