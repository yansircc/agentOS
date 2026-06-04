/**
 * Admission — pure projection contract tests (contract §7.2, §10).
 *
 * Two pure-function surfaces, no DO:
 *   1. `decideTier` 12-row truth table — admission impact for the cross
 *      product of preLease × outcome × stimulus × barrier
 *   2. `projectLease` over hand-built event lists — barrier cutoffs,
 *      (ts, id) lexicographic ordering, reinforcement filtering, adapter
 *      major-version filtering
 *
 * Same source coverage as the prior monolith's two describe blocks at
 * admission-contract.test.ts:55-82 and 212-340.
 */

import { describe, expect, it } from "vite-plus/test";

import {
  type AttemptKey,
  type BarrierRow,
  type CapabilityLease,
  type EvidenceRow,
  decideTier,
  projectLease,
} from "../src/admission";

describe("admission — decideTier truth table (contract §10)", () => {
  const supported = (lastTs: number): CapabilityLease => ({
    status: "supported",
    pinnedStrategy: "forced-tool-call",
    validUntilSoft: lastTs + 24 * 60 * 60 * 1000,
    validUntilHard: lastTs + 7 * 24 * 60 * 60 * 1000,
    lastEvidenceTs: lastTs,
  });
  const unknown: CapabilityLease = { status: "unknown" };

  // 12 rows
  it.each([
    [
      1,
      "unknown+Supported live",
      unknown,
      { class: "Supported", tokensUsed: 0 } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      2,
      "supported+Supported reinforce",
      supported(1000),
      { class: "Supported", tokensUsed: 0 } as const,
      "live" as const,
      0,
      "reinforcement" as const,
    ],
    [
      3,
      "hard-expired surfaces unknown",
      unknown,
      { class: "Supported", tokensUsed: 0 } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      4,
      "any+Supported probe",
      unknown,
      { class: "Supported", tokensUsed: 0 } as const,
      "probe" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      5,
      "ProviderRejected",
      unknown,
      { class: "ProviderRejected", status: 400, body: "" } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      6,
      "SchemaUnsupported",
      unknown,
      { class: "SchemaUnsupported", reason: "" } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      7,
      "BehaviorFailed",
      unknown,
      { class: "BehaviorFailed", sampleDigest: "" } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      8,
      "AuthError",
      unknown,
      { class: "AuthError", status: 401 } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      9,
      "RateLimited",
      unknown,
      { class: "RateLimited" } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      10,
      "TransientError",
      unknown,
      { class: "TransientError", cause: "" } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      11,
      "ConfigError",
      unknown,
      { class: "ConfigError", reason: "" } as const,
      "live" as const,
      0,
      "lease-bearing" as const,
    ],
    [
      12,
      "barrier-after-lastEvidenceTs (defense-in-depth)",
      supported(1000),
      { class: "Supported", tokensUsed: 0 } as const,
      "live" as const,
      2000,
      "lease-bearing" as const,
    ],
  ])("row %i — %s", (_n, _name, preLease, outcome, stim, barrierTs, expected) => {
    expect(decideTier(preLease, outcome, stim, { ts: barrierTs, id: 0 })).toBe(expected);
  });
});

describe("admission — projectLease pure projection (contract §7.2)", () => {
  const key: AttemptKey = {
    routeFingerprint: "fnv1a:routeX",
    schemaFingerprint: "effect-json-schema-v1:sha256:schemaX",
    strategy: "forced-tool-call",
    adapterVersion: "1.0.0",
  };

  const ev = (
    id: number,
    ts: number,
    outcome: EvidenceRow["outcome"],
    extras?: { stim?: "probe" | "live"; impact?: EvidenceRow["admissionImpact"]; adapter?: string },
  ): EvidenceRow => ({
    id,
    ts,
    kind: "llm.structured.evidence",
    key: { ...key, adapterVersion: extras?.adapter ?? key.adapterVersion },
    stimulusKind: extras?.stim ?? "live",
    outcome,
    admissionImpact: extras?.impact ?? "lease-bearing",
  });

  const barrier = (id: number, ts: number, k: Partial<AttemptKey> = key): BarrierRow => ({
    id,
    ts,
    kind: "llm.structured.invalidate",
    key: k,
  });

  it("no events → unknown", () => {
    const { lease } = projectLease([], key, 10_000);
    expect(lease.status).toBe("unknown");
  });

  it("single Supported within hard-expiry → supported lease", () => {
    const rows = [ev(1, 1000, { class: "Supported", tokensUsed: 5 })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("supported");
    if (lease.status === "supported") {
      expect(lease.lastEvidenceTs).toBe(1000);
    }
  });

  it("BehaviorFailed within 24h → unsupported lease", () => {
    const rows = [ev(1, 1000, { class: "BehaviorFailed", sampleDigest: "" })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unsupported");
    if (lease.status === "unsupported") {
      expect(lease.failureClass).toBe("BehaviorFailed");
    }
  });

  it("AuthError is NOT lease-bearing — walks past it", () => {
    // newer AuthError, older Supported → should land on Supported
    const rows = [
      ev(1, 1000, { class: "Supported", tokensUsed: 5 }),
      ev(2, 1500, { class: "AuthError", status: 401 }),
    ];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("supported");
  });

  it("barrier wipes earlier evidence", () => {
    const rows = [ev(1, 1000, { class: "Supported", tokensUsed: 5 }), barrier(2, 1500)];
    const { lease, latestBarrier } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unknown");
    expect(latestBarrier).toEqual({ ts: 1500, id: 2 });
  });

  it("reinforcement evidence is ignored by projection (lease-bearing only)", () => {
    const rows = [ev(1, 1000, { class: "Supported", tokensUsed: 5 }, { impact: "reinforcement" })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unknown");
  });

  // Codex P1: same-millisecond evidence resolution by (ts, id).
  it("same ms: newer id wins — Supported(id=1) + BehaviorFailed(id=2) at ts=100 → unsupported", () => {
    const rows = [
      ev(1, 100, { class: "Supported", tokensUsed: 5 }),
      ev(2, 100, { class: "BehaviorFailed", sampleDigest: "x" }),
    ];
    const { lease } = projectLease(rows, key, 200);
    expect(lease.status).toBe("unsupported");
    if (lease.status === "unsupported") {
      expect(lease.failureClass).toBe("BehaviorFailed");
    }
  });

  it("same ms reversed: BehaviorFailed(id=1) + Supported(id=2) at ts=100 → supported", () => {
    const rows = [
      ev(1, 100, { class: "BehaviorFailed", sampleDigest: "x" }),
      ev(2, 100, { class: "Supported", tokensUsed: 5 }),
    ];
    const { lease } = projectLease(rows, key, 200);
    expect(lease.status).toBe("supported");
  });

  it("same ms barrier vs evidence: barrier id > evidence id → evidence cut off", () => {
    // ts=100: evidence id=1, barrier id=2. Barrier comes after evidence
    // under (ts, id) order, so the Supported is wiped → unknown.
    const rows = [ev(1, 100, { class: "Supported", tokensUsed: 5 }), barrier(2, 100)];
    const { lease, latestBarrier } = projectLease(rows, key, 200);
    expect(lease.status).toBe("unknown");
    expect(latestBarrier).toEqual({ ts: 100, id: 2 });
  });

  it("same ms barrier vs evidence: barrier id < evidence id → evidence survives", () => {
    // ts=100: barrier id=1, evidence id=2. Evidence is strictly after
    // the barrier under (ts, id) order, so it survives.
    const rows = [barrier(1, 100), ev(2, 100, { class: "Supported", tokensUsed: 5 })];
    const { lease } = projectLease(rows, key, 200);
    expect(lease.status).toBe("supported");
  });

  it("different adapter major version is filtered out (§9)", () => {
    const rows = [ev(1, 1000, { class: "Supported", tokensUsed: 5 }, { adapter: "2.0.0" })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("unknown");
  });

  it("same adapter major with different minor remains valid (§9)", () => {
    const rows = [ev(1, 1000, { class: "Supported", tokensUsed: 5 }, { adapter: "1.2.3" })];
    const { lease } = projectLease(rows, key, 2000);
    expect(lease.status).toBe("supported");
  });
});
