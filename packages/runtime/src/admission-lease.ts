/**
 * Lease projection + decideTier — contract §7.2, §10.
 *
 * Owns the admission-domain state types (CapabilityLease, AttemptKey,
 * AdmissionImpact, Outcome, EvidenceRow, BarrierRow, AdmissionRow) and
 * the two pure functions that read them. No IO, no clock — `now` and
 * the event list are both inputs.
 *
 * Cycle invariant: imports nothing from sibling admission files. Other
 * admission modules import FROM here.
 */

import type { LlmRoute } from "@agent-os/kernel/llm";

export type Strategy = "forced-tool-call";

export type OutcomeClass =
  | "Supported"
  | "ProviderRejected"
  | "SchemaUnsupported"
  | "BehaviorFailed"
  | "AuthError"
  | "RateLimited"
  | "TransientError"
  | "ConfigError";

export type Outcome =
  | { readonly class: "Supported"; readonly tokensUsed: number }
  | {
      readonly class: "ProviderRejected";
      readonly status: number;
      readonly body: string;
    }
  | { readonly class: "SchemaUnsupported"; readonly reason: string }
  | { readonly class: "BehaviorFailed"; readonly sampleDigest: string }
  | { readonly class: "AuthError"; readonly status: number }
  | { readonly class: "RateLimited"; readonly retryAfterMs?: number }
  | { readonly class: "TransientError"; readonly cause: string }
  | { readonly class: "ConfigError"; readonly reason: string };

export type AttemptKey = {
  readonly routeFingerprint: string;
  readonly schemaFingerprint: string;
  readonly strategy: Strategy;
  readonly adapterVersion: string;
};

export type CapabilityLease =
  | {
      readonly status: "supported";
      readonly pinnedStrategy: Strategy;
      readonly validUntilSoft: number;
      readonly validUntilHard: number;
      readonly lastEvidenceTs: number;
    }
  | {
      readonly status: "unsupported";
      readonly failureClass: Exclude<OutcomeClass, "Supported">;
      readonly retryAfter: number;
      readonly lastEvidenceTs: number;
    }
  | { readonly status: "unknown" };

export type AdmissionImpact = "lease-bearing" | "reinforcement";

// Reconstructed evidence-row / barrier-row from `events` table.
// Exported (with `Row` suffix) so contract tests can construct projection
// inputs without going through the IO layer. Apps should not import these.
export type EvidenceRow = {
  readonly id: number;
  readonly ts: number;
  readonly kind: "llm.structured.evidence";
  readonly key: AttemptKey;
  readonly stimulusKind: "probe" | "live";
  readonly outcome: Outcome;
  readonly admissionImpact: AdmissionImpact;
};

export type BarrierRow = {
  readonly id: number;
  readonly ts: number;
  readonly kind: "llm.structured.invalidate";
  readonly key: Partial<AttemptKey>;
};

export type AdmissionRow = EvidenceRow | BarrierRow;

// LlmRoute is sourced from llm.ts but re-exported here for callers that
// want to type-check projection inputs without taking a runtime import
// from llm. Pure type re-export.
export type { LlmRoute };

// ============================================================
// decideTier (contract §10)
//   Pure function; NO IO, NO clock; depends only on pre-call inputs.
// ============================================================

/**
 * Spec-25 §10 admission-impact rule. Computed BEFORE the evidence
 * append (no post-append re-projection — that's the very anti-pattern
 * contract forbids; race + cost).
 *
 * - probe → lease-bearing (always admission-relevant)
 * - non-Supported → lease-bearing (failures + non-lease classes both
 *   required in DO per §10 ops requirement)
 * - Supported + preLease=unknown/hard-expired → lease-bearing (admission-forming)
 * - Supported + preLease=supported + no intervening barrier → reinforcement
 * - Supported + preLease=supported + intervening barrier (defense-in-depth;
 *   should be unreachable under a correct projection) → lease-bearing
 */
export const decideTier = (
  preLease: CapabilityLease,
  outcome: Outcome,
  stimulusKind: "probe" | "live",
  latestBarrierTs: number,
): AdmissionImpact => {
  if (stimulusKind === "probe") return "lease-bearing";
  if (outcome.class !== "Supported") return "lease-bearing";
  if (preLease.status === "supported") {
    if (latestBarrierTs > preLease.lastEvidenceTs) return "lease-bearing";
    return "reinforcement";
  }
  return "lease-bearing";
};

// ============================================================
// Lease projection (contract §7.2)
//   Pure function. SSoT is `events` table; projection is derivation only.
// ============================================================

const SOFT_REFRESH_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_HARD_MS = 7 * 24 * 60 * 60 * 1000;

const unsupportedTtlMs = (cls: Exclude<OutcomeClass, "Supported">): number => {
  switch (cls) {
    case "ProviderRejected":
    case "SchemaUnsupported":
      return 7 * 24 * 60 * 60 * 1000;
    case "BehaviorFailed":
      return 24 * 60 * 60 * 1000;
    case "AuthError":
    case "RateLimited":
    case "TransientError":
    case "ConfigError":
      return 0;
  }
};

const majorOf = (semver: string): string => semver.split(".")[0] ?? "0";

const nonVersionKeysMatch = (
  a: AttemptKey,
  b: Pick<AttemptKey, "routeFingerprint" | "schemaFingerprint" | "strategy">,
): boolean =>
  a.routeFingerprint === b.routeFingerprint &&
  a.schemaFingerprint === b.schemaFingerprint &&
  a.strategy === b.strategy;

const evidenceKeyMatches = (current: AttemptKey, evidence: AttemptKey): boolean =>
  nonVersionKeysMatch(current, evidence) &&
  majorOf(current.adapterVersion) === majorOf(evidence.adapterVersion);

const barrierAdapterVersionMatches = (current: string, barrier: string | undefined): boolean => {
  if (barrier === undefined) return true;
  if (barrier.endsWith(".x")) return majorOf(current) === barrier.slice(0, -2);
  return current === barrier;
};

const barrierKeyMatches = (current: AttemptKey, barrier: Partial<AttemptKey>): boolean => {
  if (
    barrier.routeFingerprint !== undefined &&
    current.routeFingerprint !== barrier.routeFingerprint
  )
    return false;
  if (
    barrier.schemaFingerprint !== undefined &&
    current.schemaFingerprint !== barrier.schemaFingerprint
  )
    return false;
  if (barrier.strategy !== undefined && current.strategy !== barrier.strategy) return false;
  return barrierAdapterVersionMatches(current.adapterVersion, barrier.adapterVersion);
};

/** Project the latest lease for `key` from the given event list at time `now`.
 *
 *  Pure function. Reads no IO. Returns `{lease, latestBarrierTs}` so callers
 *  computing admission impact can use both inputs without re-scanning.
 *
 *  Total order over (`ts`, `id`): SQLite's `id` is monotonically increasing
 *  via `INTEGER PRIMARY KEY AUTOINCREMENT`, so even when two events share
 *  the same wall-clock millisecond (`ts`), the later writer has the larger
 *  `id`. Projection uses `(ts, id)` lexicographic ordering everywhere —
 *  both for picking the latest evidence AND for cutting off barriers.
 *
 *  Skipped (per §8): AuthError / RateLimited / TransientError / ConfigError —
 *  not capability facts; walk past them to find a real lease-bearing event.
 *
 *  Filtered: reinforcement evidence (admission must read lease-bearing rows
 *  only — contract §10).
 *  Filtered: events with a different adapter major version (§9).
 *  Filtered: events strictly before the latest barrier under `(ts, id)`.
 */
export const projectLease = (
  rows: ReadonlyArray<AdmissionRow>,
  key: AttemptKey,
  now: number,
): { readonly lease: CapabilityLease; readonly latestBarrierTs: number } => {
  const curMajor = majorOf(key.adapterVersion);

  // Find the latest barrier under (ts, id) ordering.
  let latestBarrierTs = 0;
  let latestBarrierId = 0;
  for (const r of rows) {
    if (r.kind === "llm.structured.invalidate" && barrierKeyMatches(key, r.key)) {
      if (r.ts > latestBarrierTs || (r.ts === latestBarrierTs && r.id > latestBarrierId)) {
        latestBarrierTs = r.ts;
        latestBarrierId = r.id;
      }
    }
  }

  // An evidence row counts as "after the barrier" iff
  //   (ev.ts, ev.id) > (barrier.ts, barrier.id)   lexicographic.
  const afterBarrier = (ev: EvidenceRow): boolean =>
    ev.ts > latestBarrierTs || (ev.ts === latestBarrierTs && ev.id > latestBarrierId);

  const eligible: EvidenceRow[] = [];
  for (const r of rows) {
    if (r.kind !== "llm.structured.evidence") continue;
    if (!evidenceKeyMatches(key, r.key)) continue;
    if (r.admissionImpact !== "lease-bearing") continue;
    if (!afterBarrier(r)) continue;
    if (majorOf(r.key.adapterVersion) !== curMajor) continue;
    eligible.push(r);
  }
  // Newer-first by (ts, id).
  eligible.sort((a, b) => b.ts - a.ts || b.id - a.id);

  for (const ev of eligible) {
    const cls = ev.outcome.class;
    if (
      cls === "AuthError" ||
      cls === "RateLimited" ||
      cls === "TransientError" ||
      cls === "ConfigError"
    )
      continue;
    if (cls === "Supported") {
      if (now - ev.ts < SUPPORTED_HARD_MS) {
        return {
          lease: {
            status: "supported",
            pinnedStrategy: ev.key.strategy,
            validUntilSoft: ev.ts + SOFT_REFRESH_MS,
            validUntilHard: ev.ts + SUPPORTED_HARD_MS,
            lastEvidenceTs: ev.ts,
          },
          latestBarrierTs,
        };
      }
      continue;
    }
    const ttl = unsupportedTtlMs(cls);
    if (ttl === 0) continue;
    if (now - ev.ts < ttl) {
      return {
        lease: {
          status: "unsupported",
          failureClass: cls,
          retryAfter: ev.ts + ttl,
          lastEvidenceTs: ev.ts,
        },
        latestBarrierTs,
      };
    }
  }

  return { lease: { status: "unknown" }, latestBarrierTs };
};
