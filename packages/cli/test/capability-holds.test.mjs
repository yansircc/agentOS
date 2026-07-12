import assert from "node:assert/strict";
import { test } from "node:test";

import { capabilityHoldRows, validateCapabilityHolds } from "../src/generate/capability-holds.mjs";

const validHold = {
  id: "live-llm-streaming",
  capability: "live LLM response streaming",
  status: "held",
  summary: "Terminal authority is not yet proven.",
  promotion: {
    missingContractRefs: ["contract:llm-live-stream/terminal-response@1"],
    requiredProofRefs: ["proof:llm-live-stream/terminal-parity"],
  },
};

void test("capability holds accept reference-only promotion contracts", () => {
  assert.deepEqual(validateCapabilityHolds([validHold]), []);
  assert.deepEqual(capabilityHoldRows([validHold]), [
    [
      "`live-llm-streaming`",
      "live LLM response streaming",
      "`held`",
      "`contract:llm-live-stream/terminal-response@1`",
      "`proof:llm-live-stream/terminal-parity`",
      "Terminal authority is not yet proven.",
    ],
  ]);
});

void test("capability holds fail closed on incomplete promotion fields", () => {
  const failures = validateCapabilityHolds([
    { ...validHold, promotion: { missingContractRefs: validHold.promotion.missingContractRefs } },
  ]);
  assert.deepEqual(failures, [
    "docs/surface.json: holds/live-llm-streaming/promotion must contain exactly missingContractRefs and requiredProofRefs",
  ]);
});

void test("capability holds reject embedded schemas and malformed refs", () => {
  const failures = validateCapabilityHolds([
    {
      ...validHold,
      promotion: {
        missingContractRefs: [{ id: "terminal", schema: {} }],
        requiredProofRefs: ["terminal parity"],
      },
    },
  ]);
  assert.deepEqual(failures, [
    "docs/surface.json: holds/live-llm-streaming/promotion/missingContractRefs has invalid ref [object Object]",
    "docs/surface.json: holds/live-llm-streaming/promotion/requiredProofRefs has invalid ref terminal parity",
  ]);
});
