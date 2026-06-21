/**
 * Admission public barrel.
 *
 * Runtime Cloudflare admission modules are split by protocol role. All
 * imports `from "./admission"` / `from "../src/admission"` continue to
 * resolve here via dir-as-module. The actual implementation is split
 * along contract axes:
 *
 *   agent-schema.ts  AgentSchema contract construction
 *   fingerprint.ts   schema contract construction
 *   payload.ts       evidence/invalidate Schema + SQL loader
 *   admission.ts     attemptStructured + invalidate orchestration
 *
 * Public surface is exactly the set of symbols the prior monolith
 * exported. Tests and apps see no change.
 */

// ── Schema types + validator ───────────────────────────────────
export type { AgentSchemaSpec } from "@agent-os/core/agent-schema";

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
  BarrierCursor,
  AdmissionRow,
  LlmRoute,
} from "@agent-os/core/runtime-protocol";
export { decideTier, projectLease } from "@agent-os/core/runtime-protocol";

// ── Canonical fingerprint algebra ──────────────────────────────
export { FINGERPRINT_ALGO_VERSION, makeAdmissionSchemaSpec } from "@agent-os/core/runtime-protocol";

// ── Orchestration + Live layer ─────────────────────────────────
export type {
  ProbeInput,
  LiveInput,
  Stimulus,
  DecodedOutput,
  AttemptSpec,
  AttemptResult,
  InvalidateSpec,
} from "@agent-os/core/runtime-protocol";
export { Admission } from "@agent-os/runtime";
export { AdmissionLive } from "./admission";
