/**
 * Admission public barrel.
 *
 * Replaces the former monolithic `packages/backends/cloudflare-do/src/admission.ts`. All
 * imports `from "./admission"` / `from "../src/admission"` continue to
 * resolve here via dir-as-module. The actual implementation is split
 * along contract axes:
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
export type {
  JsonSchemaObject,
  JsonSchemaNode,
  SchemaContract,
} from "@agent-os/kernel/json-schema";
export { validateAgainstSchema } from "@agent-os/kernel/json-schema";

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
} from "@agent-os/runtime";
export { decideTier, projectLease } from "@agent-os/runtime";

// ── Canonical fingerprint algebra ──────────────────────────────
export { FINGERPRINT_ALGO_VERSION, makeSchemaContract, routeFingerprint } from "@agent-os/runtime";

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
} from "@agent-os/runtime";
export type { AdapterMode } from "./admission";
export { Admission } from "@agent-os/runtime";
export { AdmissionLive, ADAPTER_VERSION } from "./admission";
