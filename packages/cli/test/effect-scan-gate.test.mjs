import assert from "node:assert/strict";
import { test } from "node:test";

import {
  effectScanGateFailures,
  validateEffectScanGateJson,
} from "../src/check/effect-scan-gate.mjs";

const baseProjection = (overrides = {}) => ({
  schemaVersion: 1,
  ok: true,
  tiers: {
    block: [],
    report: [],
    review: {
      signals: {
        blocking: false,
        total: 1,
        byKind: { "profile-signal": 1 },
      },
    },
  },
  ...overrides,
});

void test("effect scan gate accepts scanner-owned review signals as non-gating", () => {
  const projection = baseProjection();
  assert.deepEqual(validateEffectScanGateJson(projection), []);
  assert.deepEqual(effectScanGateFailures(projection, 0), []);
});

void test("effect scan gate fails on scanner-owned block findings", () => {
  const projection = baseProjection({
    ok: false,
    tiers: {
      block: [{ rule: "compiler-diagnostic", package: "packages/runtime" }],
      report: [],
      review: { signals: { blocking: false, total: 0, byKind: {} } },
    },
  });
  assert.deepEqual(effectScanGateFailures(projection, 1), [
    "effect scan gate-json ok is false",
    "effect scan gate-json contains 1 scanner-owned block finding(s)",
  ]);
});

void test("effect scan gate fails closed without machine severity projection", () => {
  assert.deepEqual(effectScanGateFailures({ schemaVersion: 1, ok: true }, 0), [
    "effect scan gate-json tiers object is required",
  ]);
  assert.deepEqual(
    effectScanGateFailures({ schemaVersion: 1, ok: true, tiers: { report: [] } }, 0),
    [
      "effect scan gate-json tiers.block array is required",
      "effect scan gate-json tiers.review object is required",
    ],
  );
});

void test("effect scan gate rejects process/json disagreement", () => {
  assert.deepEqual(effectScanGateFailures(baseProjection(), 1), [
    "effect scan process exited 1 while gate-json reported no block findings",
  ]);
});
