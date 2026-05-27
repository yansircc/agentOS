/**
 * Admission public barrel.
 *
 * Replaces the former monolithic `packages/core/src/admission.ts`. All
 * imports `from "./admission"` / `from "../src/admission"` continue to
 * resolve here via dir-as-module. The actual implementation is split
 * along spec-25 axes:
 *
 *   json-schema.ts   types + validator (closed-dialect JSON Schema)
 *   fingerprint.ts   canonical-JSON algebra (route + schema)
 *   lease.ts         projection state + decideTier + projectLease
 *   payload.ts       evidence/invalidate Schema + SQL loader
 *   admission.ts     attemptStructured + invalidate orchestration
 *
 * Public surface is exactly the set of symbols the prior monolith
 * exported. Tests and apps see no change.
 */

// ── Schema types + validator ───────────────────────────────────
export type { JsonSchemaObject, JsonSchemaNode, SchemaContract } from "./json-schema";
export { validateAgainstSchema } from "./json-schema";

// ── Lease projection state + pure functions ────────────────────
export type {
  Strategy,
  OutcomeClass,
  Outcome,
  AttemptKey,
  CapabilityLease,
  AdmissionImpact,
  EvidenceRow,
  BarrierRow,
  AdmissionRow,
  LlmRoute,
} from "./lease";
export { decideTier, projectLease } from "./lease";

// ── Canonical fingerprint algebra ──────────────────────────────
export { FINGERPRINT_ALGO_VERSION, makeSchemaContract, routeFingerprint } from "./fingerprint";

// ── Orchestration + Live layer ─────────────────────────────────
export type {
  ProbeInput,
  LiveInput,
  DeliverSpec,
  Stimulus,
  DecodedOutput,
  AttemptSpec,
  AttemptResult,
  InvalidateSpec,
  AdapterMode,
} from "./admission";
export { Admission, AdmissionLive, ADAPTER_VERSION } from "./admission";
