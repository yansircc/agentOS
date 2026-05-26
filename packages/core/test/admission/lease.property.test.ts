/**
 * Admission lease model tests.
 *
 * These tests generate arbitrary ledger histories and compare projectLease
 * against an independent oracle for the spec-25 rules:
 *   - matching route/schema/strategy
 *   - adapter compatibility by major version
 *   - barrier cutoff by (ts, id)
 *   - reinforcement and non-capability outcomes never form leases
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type AdmissionRow,
  type AttemptKey,
  type BarrierRow,
  type CapabilityLease,
  type EvidenceRow,
  type Outcome,
  projectLease,
} from "../../src/admission";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 10 * DAY_MS;

const key: AttemptKey = {
  routeFingerprint: "route-a",
  schemaFingerprint: "schema-a",
  strategy: "forced-tool-call",
  adapterVersion: "1.4.0",
};

type RowSpec =
  | {
      readonly tag: "evidence";
      readonly ts: number;
      readonly keyMode: "target" | "same-major" | "other-major" | "other-route";
      readonly outcome: Outcome;
      readonly impact: EvidenceRow["admissionImpact"];
      readonly stimulusKind: EvidenceRow["stimulusKind"];
    }
  | {
      readonly tag: "barrier";
      readonly ts: number;
      readonly keyMode:
        | "target"
        | "target-wildcard-major"
        | "target-omitted-version"
        | "other-major"
        | "other-route";
    };

const keyForEvidence = (
  mode: Extract<RowSpec, { tag: "evidence" }>["keyMode"],
): AttemptKey => {
  switch (mode) {
    case "target":
      return key;
    case "same-major":
      return { ...key, adapterVersion: "1.0.1" };
    case "other-major":
      return { ...key, adapterVersion: "2.0.0" };
    case "other-route":
      return { ...key, routeFingerprint: "route-b" };
  }
};

const keyForBarrier = (
  mode: Extract<RowSpec, { tag: "barrier" }>["keyMode"],
): Partial<AttemptKey> => {
  switch (mode) {
    case "target":
      return key;
    case "target-wildcard-major":
      return { ...key, adapterVersion: "1.x" };
    case "target-omitted-version": {
      const { adapterVersion: _adapterVersion, ...rest } = key;
      return rest;
    }
    case "other-major":
      return { ...key, adapterVersion: "2.0.0" };
    case "other-route":
      return { ...key, routeFingerprint: "route-b" };
  }
};

const rowFromSpec = (spec: RowSpec, index: number): AdmissionRow => {
  const id = index + 1;
  if (spec.tag === "barrier") {
    return {
      id,
      ts: spec.ts,
      kind: "llm.structured.invalidate",
      key: keyForBarrier(spec.keyMode),
    } satisfies BarrierRow;
  }
  return {
    id,
    ts: spec.ts,
    kind: "llm.structured.evidence",
    key: keyForEvidence(spec.keyMode),
    stimulusKind: spec.stimulusKind,
    outcome: spec.outcome,
    admissionImpact: spec.impact,
  } satisfies EvidenceRow;
};

const majorOf = (semver: string): string => semver.split(".")[0] ?? "0";

const barrierMatches = (barrier: Partial<AttemptKey>): boolean => {
  if (
    barrier.routeFingerprint !== undefined &&
    barrier.routeFingerprint !== key.routeFingerprint
  )
    return false;
  if (
    barrier.schemaFingerprint !== undefined &&
    barrier.schemaFingerprint !== key.schemaFingerprint
  )
    return false;
  if (barrier.strategy !== undefined && barrier.strategy !== key.strategy)
    return false;
  if (barrier.adapterVersion === undefined) return true;
  if (barrier.adapterVersion.endsWith(".x")) {
    return majorOf(key.adapterVersion) === barrier.adapterVersion.slice(0, -2);
  }
  return barrier.adapterVersion === key.adapterVersion;
};

const evidenceMatches = (row: EvidenceRow): boolean =>
  row.key.routeFingerprint === key.routeFingerprint &&
  row.key.schemaFingerprint === key.schemaFingerprint &&
  row.key.strategy === key.strategy &&
  majorOf(row.key.adapterVersion) === majorOf(key.adapterVersion);

const ttlForUnsupported = (outcome: Outcome): number => {
  switch (outcome.class) {
    case "ProviderRejected":
    case "SchemaUnsupported":
      return 7 * DAY_MS;
    case "BehaviorFailed":
      return DAY_MS;
    case "Supported":
    case "AuthError":
    case "RateLimited":
    case "TransientError":
    case "ConfigError":
      return 0;
  }
};

const oracle = (rows: ReadonlyArray<AdmissionRow>): CapabilityLease => {
  let barrierTs = 0;
  let barrierId = 0;
  for (const row of rows) {
    if (
      row.kind !== "llm.structured.invalidate" ||
      !barrierMatches(row.key)
    ) {
      continue;
    }
    if (row.ts > barrierTs || (row.ts === barrierTs && row.id > barrierId)) {
      barrierTs = row.ts;
      barrierId = row.id;
    }
  }

  const eligible = rows
    .filter((row): row is EvidenceRow => row.kind === "llm.structured.evidence")
    .filter(evidenceMatches)
    .filter((row) => row.admissionImpact === "lease-bearing")
    .filter(
      (row) => row.ts > barrierTs || (row.ts === barrierTs && row.id > barrierId),
    )
    .sort((a, b) => b.ts - a.ts || b.id - a.id);

  for (const row of eligible) {
    if (row.outcome.class === "Supported") {
      if (NOW - row.ts < 7 * DAY_MS) {
        return {
          status: "supported",
          pinnedStrategy: row.key.strategy,
          validUntilSoft: row.ts + DAY_MS,
          validUntilHard: row.ts + 7 * DAY_MS,
          lastEvidenceTs: row.ts,
        };
      }
      continue;
    }
    const ttl = ttlForUnsupported(row.outcome);
    if (ttl > 0 && NOW - row.ts < ttl) {
      return {
        status: "unsupported",
        failureClass: row.outcome.class,
        retryAfter: row.ts + ttl,
        lastEvidenceTs: row.ts,
      };
    }
  }
  return { status: "unknown" };
};

const outcomeArb: fc.Arbitrary<Outcome> = fc.oneof(
  fc.record({ class: fc.constant("Supported"), tokensUsed: fc.nat(1000) }),
  fc.record({
    class: fc.constant("ProviderRejected"),
    status: fc.integer({ min: 400, max: 499 }),
    body: fc.string({ maxLength: 16 }),
  }),
  fc.record({
    class: fc.constant("SchemaUnsupported"),
    reason: fc.string({ maxLength: 16 }),
  }),
  fc.record({
    class: fc.constant("BehaviorFailed"),
    sampleDigest: fc.string({ maxLength: 16 }),
  }),
  fc.record({
    class: fc.constant("AuthError"),
    status: fc.constantFrom(401, 403),
  }),
  fc.record({ class: fc.constant("RateLimited") }),
  fc.record({
    class: fc.constant("TransientError"),
    cause: fc.string({ maxLength: 16 }),
  }),
  fc.record({
    class: fc.constant("ConfigError"),
    reason: fc.string({ maxLength: 16 }),
  }),
);

const rowSpecArb: fc.Arbitrary<RowSpec> = fc.oneof(
  fc.record({
    tag: fc.constant("evidence"),
    ts: fc.integer({ min: 0, max: NOW }),
    keyMode: fc.constantFrom("target", "same-major", "other-major", "other-route"),
    outcome: outcomeArb,
    impact: fc.constantFrom("lease-bearing", "reinforcement"),
    stimulusKind: fc.constantFrom("probe", "live"),
  }),
  fc.record({
    tag: fc.constant("barrier"),
    ts: fc.integer({ min: 0, max: NOW }),
    keyMode: fc.constantFrom(
      "target",
      "target-wildcard-major",
      "target-omitted-version",
      "other-major",
      "other-route",
    ),
  }),
);

describe("admission projectLease properties", () => {
  it("matches the independent lease oracle over generated histories", () => {
    fc.assert(
      fc.property(fc.array(rowSpecArb, { maxLength: 100 }), (specs) => {
        const rows = specs.map(rowFromSpec);
        expect(projectLease(rows, key, NOW).lease).toEqual(oracle(rows));
      }),
      { numRuns: 1000 },
    );
  });
});
