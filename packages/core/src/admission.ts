/**
 * @agent-os/core admission — spec-25 structured output via evidence-derived
 * capability lease.
 *
 * Module-private. Public surface is `submitAgent({ outputSchema })` in
 * submit-agent.ts. App-side never imports from this file directly.
 *
 * Algebra:
 *   attemptStructured(scope, route, schema, strategy, stimulus)
 *     → 1. project lease (read events, no writes)
 *     → 2. gate: if cached unsupported and not expired → short-circuit
 *     → 3. adapter.encode → ai.run → adapter.decode | adapter.classify
 *     → 4. decideTier(preLease, outcome, stimulusKind, latestBarrierTs)
 *     → 5. transactionSync(evidence row + optional deliver row)
 *     → 6. fire EventBus
 *
 * State ownership (spec-25 §2 + spec-24 §3.1):
 *   `events.kind = 'llm.structured.evidence'`   sole admission evidence writer
 *   `events.kind = 'llm.structured.invalidate'` sole barrier writer
 *   CapabilityLease, latestBarrierTs            pure projection over events
 *
 * No separate `leases` table. No KV cache. No second writer.
 *
 * Spec: docs/spec-25-llm-admission.md
 * Spike: spikes/04-llm-admission/
 */

import { Clock, Context, Effect, Layer, Schema } from "effect";
import { EventBus } from "./event-bus";
import { JsonStringifyError, SqlError, safeStringify } from "./errors";
import { AiBinding } from "./llm";
import type { LedgerEvent } from "./types";

// ============================================================
// SECTION A — Types (spec-25 §3 §4 §5 §7 §8)
// ============================================================

export type LlmRoute = {
  readonly kind: "cf-ai-binding";
  readonly modelId: string;
  readonly gatewayRef?: string;
};

export type Strategy = "forced-tool-call";

export type JsonSchemaObject = {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean;
};

export type JsonSchemaNode =
  | { readonly type: "string"; readonly enum?: ReadonlyArray<string> }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "array"; readonly items: JsonSchemaNode }
  | JsonSchemaObject;

export type SchemaContract = {
  readonly schema: JsonSchemaObject;
  readonly fingerprint: string;     // §4.1: "<algoVer>:sha256:<hex>"
};

export type ProbeInput = { readonly synthetic: unknown };
export type LiveInput = { readonly userText: string };
export type DeliverSpec = {
  readonly event: string;
  readonly payload: unknown;
};

export type Stimulus<O> =
  | { readonly kind: "probe"; readonly synthetic: ProbeInput }
  | {
      readonly kind: "live";
      readonly userInput: LiveInput;
      // §5: pure function returning data; NEVER an Effect.
      readonly deliver: (decoded: O) => DeliverSpec;
    };

export type DecodedOutput = Record<string, unknown>;

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
  | { readonly class: "ProviderRejected"; readonly status: number; readonly body: string }
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

// ============================================================
// SECTION B — Canonical fingerprint (spec-25 §4.1)
//   - rule a: sort object keys recursively
//   - rule c': sort set-semantics arrays (`required`, `enum`)
//     (discovered in spike-04 — see docs/spec-25 §4.1)
//   - rule d: strip non-semantic annotations
// ============================================================

export const FINGERPRINT_ALGO_VERSION = "effect-json-schema-v1";

const SET_SEMANTICS_ARRAYS = new Set(["required", "enum"]);
const STRIP_KEYS = new Set(["title", "description", "examples", "$comment"]);

const canonicalize = (node: unknown, parentKey?: string): unknown => {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    const mapped = node.map((item) => canonicalize(item));
    if (parentKey !== undefined && SET_SEMANTICS_ARRAYS.has(parentKey)) {
      return [...mapped].sort((a, b) => {
        const sa = typeof a === "string" ? a : JSON.stringify(a);
        const sb = typeof b === "string" ? b : JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      });
    }
    return mapped;
  }
  const obj = node as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => !STRIP_KEYS.has(k) && !k.startsWith("x-"))
    .sort();
  const out: Record<string, unknown> = {};
  for (const k of sortedKeys) out[k] = canonicalize(obj[k], k);
  return out;
};

const canonicalJsonString = (node: unknown): string =>
  JSON.stringify(canonicalize(node));

const sha256Hex = async (input: string): Promise<string> => {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/** Build a SchemaContract from a JSON Schema object.
 *
 *  Deterministic across implementations: same canonicalization rules yield
 *  byte-equal canonical JSON, then SHA-256, then identical fingerprint string.
 *  Algorithm version is embedded in the fingerprint prefix so future
 *  canonicalization changes auto-invalidate old leases. */
export const makeSchemaContract = (
  schema: JsonSchemaObject,
): Effect.Effect<SchemaContract> =>
  Effect.gen(function* () {
    const canon = canonicalJsonString(schema);
    const hex = yield* Effect.promise(() => sha256Hex(canon));
    return {
      schema,
      fingerprint: `${FINGERPRINT_ALGO_VERSION}:sha256:${hex}`,
    };
  });

/** Route key is the canonical JSON of the route, prefixed with an algorithm
 *  version tag. We deliberately do NOT hash it.
 *
 *  Earlier this used a 32-bit FNV-1a hash — Codex caught a real collision
 *  (`@cf/3hwlz7pq9l` and `@cf/x3qxkshczh` both mapping to `fnv1a:b307092e`),
 *  which would alias an unsupported lease for one model onto another model.
 *  The hash space is large in absolute terms but the SSoT key cannot be a
 *  probabilistic identity. Canonical JSON is determinstic, collision-free
 *  by construction, and only ~80 chars in practice. The `route-json-v1:`
 *  prefix lets a future canonicalization change auto-invalidate stored
 *  keys without an adapter version bump. */
export const routeFingerprint = (route: LlmRoute): string => {
  const canon = canonicalJsonString({
    kind: route.kind,
    modelId: route.modelId,
    gatewayRef: route.gatewayRef ?? null,
  });
  return `route-json-v1:${canon}`;
};

// ============================================================
// SECTION C — Adapter law (spec-25 §6) for cf-ai-binding
// ============================================================

export const ADAPTER_VERSION = "1.0.0";

export type AdapterMode = "production" | "test-decode-mismatch";

type ProviderRequest = {
  readonly model: string;
  readonly body: Record<string, unknown>;
};

type DecodeResult =
  | { readonly ok: true; readonly decoded: DecodedOutput }
  | { readonly ok: false; readonly outcome: Outcome };

/** Validator for the small JSON Schema dialect we accept. Sufficient for
 *  spec-25 §4 contract; not a full draft-2020-12 implementation.
 *  Enforces: type, required, properties walk, array items, string enum,
 *            additionalProperties:false (closed object).
 */
const validateAgainstSchema = (
  value: unknown,
  schema: JsonSchemaNode,
): string[] => {
  const violations: string[] = [];
  const walk = (v: unknown, s: JsonSchemaNode, path: string): void => {
    if (s.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        violations.push(`${path}:not-object`);
        return;
      }
      const obj = v as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in obj)) violations.push(`${path}.${req}:missing`);
      }
      if (s.additionalProperties === false) {
        for (const k of Object.keys(obj)) {
          if (!(k in s.properties)) {
            violations.push(`${path}.${k}:unknown-property`);
          }
        }
      }
      for (const [k, sub] of Object.entries(s.properties)) {
        if (k in obj) walk(obj[k], sub, `${path}.${k}`);
      }
    } else if (s.type === "array") {
      if (!Array.isArray(v)) {
        violations.push(`${path}:not-array`);
        return;
      }
      v.forEach((item, i) => walk(item, s.items, `${path}[${i}]`));
    } else if (s.type === "string") {
      if (typeof v !== "string") violations.push(`${path}:not-string`);
      else if (s.enum && !s.enum.includes(v))
        violations.push(`${path}:not-in-enum`);
    } else if (s.type === "number") {
      if (typeof v !== "number") violations.push(`${path}:not-number`);
    } else if (s.type === "boolean") {
      if (typeof v !== "boolean") violations.push(`${path}:not-boolean`);
    }
  };
  walk(value, schema, "$");
  return violations;
};

export const cfAiBindingAdapter = {
  kind: "cf-ai-binding" as const,
  version: ADAPTER_VERSION,

  encode(
    route: LlmRoute,
    schema: SchemaContract,
    stimulus: { kind: "probe"; synthetic: ProbeInput } | { kind: "live"; userInput: LiveInput },
    _strategy: Strategy,
  ): ProviderRequest {
    // `Strategy` is a closed union with a single value ("forced-tool-call")
    // exhausted by the type system. No runtime check needed — adding a new
    // strategy is a TS-level breaking change that surfaces on the
    // tool_choice construction site below.
    const userText =
      stimulus.kind === "live"
        ? stimulus.userInput.userText
        : String(stimulus.synthetic.synthetic);
    return {
      model: route.modelId,
      body: {
        messages: [
          {
            role: "system",
            content:
              "Return strictly structured output by calling the submit tool. Do not respond in free text.",
          },
          { role: "user", content: userText },
        ],
        max_tokens: 2048,
        tools: [
          {
            type: "function",
            function: {
              name: "_submit_structured",
              description:
                "Submit the structured result. Args ARE the result.",
              parameters: schema.schema,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "_submit_structured" },
        },
      },
    };
  },

  decode(
    response: { readonly raw: unknown },
    schema: SchemaContract,
    _strategy: Strategy,
    mode: AdapterMode = "production",
  ): DecodeResult {
    if (mode === "test-decode-mismatch") {
      return {
        ok: false,
        outcome: {
          class: "BehaviorFailed",
          sampleDigest: "synthetic-test-decode-mismatch",
        },
      };
    }
    const raw = response.raw as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
    };
    const tc = raw.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!tc || tc.name !== "_submit_structured" || !tc.arguments) {
      return {
        ok: false,
        outcome: { class: "BehaviorFailed", sampleDigest: "no-tool-call" },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(tc.arguments);
    } catch (e) {
      return {
        ok: false,
        outcome: {
          class: "BehaviorFailed",
          sampleDigest: `args-parse-failed:${String(e).slice(0, 40)}`,
        },
      };
    }
    const violations = validateAgainstSchema(parsed, schema.schema);
    if (violations.length > 0) {
      return {
        ok: false,
        outcome: {
          class: "BehaviorFailed",
          sampleDigest: `violations:${violations.join(",")}`.slice(0, 120),
        },
      };
    }
    return { ok: true, decoded: parsed as DecodedOutput };
  },

  classify(error: unknown): Outcome {
    const msg = error instanceof Error ? error.message : String(error);
    const lower = msg.toLowerCase();
    if (lower.includes("401") || lower.includes("unauthor"))
      return { class: "AuthError", status: 401 };
    if (lower.includes("429") || lower.includes("rate"))
      return { class: "RateLimited" };
    if (lower.includes("timeout") || lower.includes("network"))
      return { class: "TransientError", cause: msg };
    return { class: "ProviderRejected", status: 0, body: msg };
  },
};

// ============================================================
// SECTION D — decideTier (spec-25 §10, spike-04 §A5)
//   Pure function; NO IO, NO clock; depends only on pre-call inputs.
// ============================================================

/**
 * Spec-25 §10 admission-impact rule. Computed BEFORE the evidence
 * append (no post-append re-projection — that's the very anti-pattern
 * spec-25 forbids; race + cost).
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
// SECTION E — Lease projection (spec-25 §7.2)
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

const keysMatch = (a: AttemptKey, b: Partial<AttemptKey>): boolean => {
  if (b.routeFingerprint !== undefined && a.routeFingerprint !== b.routeFingerprint)
    return false;
  if (b.schemaFingerprint !== undefined && a.schemaFingerprint !== b.schemaFingerprint)
    return false;
  if (b.strategy !== undefined && a.strategy !== b.strategy) return false;
  if (b.adapterVersion !== undefined && a.adapterVersion !== b.adapterVersion)
    return false;
  return true;
};

const majorOf = (semver: string): string => semver.split(".")[0] ?? "0";

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
 *  only — spec-25 §10).
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
    if (r.kind === "llm.structured.invalidate" && keysMatch(key, r.key)) {
      if (
        r.ts > latestBarrierTs ||
        (r.ts === latestBarrierTs && r.id > latestBarrierId)
      ) {
        latestBarrierTs = r.ts;
        latestBarrierId = r.id;
      }
    }
  }

  // An evidence row counts as "after the barrier" iff
  //   (ev.ts, ev.id) > (barrier.ts, barrier.id)   lexicographic.
  const afterBarrier = (ev: EvidenceRow): boolean =>
    ev.ts > latestBarrierTs ||
    (ev.ts === latestBarrierTs && ev.id > latestBarrierId);

  const eligible: EvidenceRow[] = [];
  for (const r of rows) {
    if (r.kind !== "llm.structured.evidence") continue;
    if (!keysMatch(key, r.key)) continue;
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

// ============================================================
// SECTION F — Admission Context.Tag + Live Layer
// ============================================================

export type AttemptSpec<O> = {
  readonly scope: string;
  readonly route: LlmRoute;
  readonly schemaContract: SchemaContract;
  readonly strategy: Strategy;
  readonly stimulus: Stimulus<O>;
  /** Test-only: lets contract tests force decode failures deterministically.
   *  Production callers leave this undefined / "production". */
  readonly adapterMode?: AdapterMode;
};

export type AttemptResult<O> =
  | {
      readonly ok: true;
      readonly decoded: O;
      readonly outcome: Outcome;
      readonly lease: CapabilityLease;
      readonly admissionImpact: AdmissionImpact;
      readonly shortCircuited: false;
    }
  | {
      readonly ok: false;
      readonly outcome: Outcome;
      readonly lease: CapabilityLease;
      readonly admissionImpact: AdmissionImpact;
      readonly shortCircuited: boolean;
    };

export type InvalidateSpec = {
  readonly scope: string;
  readonly key: Partial<AttemptKey>;
  readonly reason: string;
  readonly by: string;
};

export class Admission extends Context.Tag("@agent-os/Admission")<
  Admission,
  {
    readonly attemptStructured: <O>(
      spec: AttemptSpec<O>,
    ) => Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError>;
    readonly invalidate: (
      spec: InvalidateSpec,
    ) => Effect.Effect<{ readonly barrierId: number }, SqlError | JsonStringifyError>;
  }
>() {}

const reconstructOutcomeFromLease = (
  lease: CapabilityLease & { status: "unsupported" },
): Outcome => {
  switch (lease.failureClass) {
    case "BehaviorFailed":
      return { class: "BehaviorFailed", sampleDigest: "cached-short-circuit" };
    case "ProviderRejected":
      return { class: "ProviderRejected", status: 0, body: "cached-short-circuit" };
    case "SchemaUnsupported":
      return { class: "SchemaUnsupported", reason: "cached-short-circuit" };
    case "AuthError":
      return { class: "AuthError", status: 401 };
    case "RateLimited":
      return { class: "RateLimited" };
    case "TransientError":
      return { class: "TransientError", cause: "cached-short-circuit" };
    case "ConfigError":
      return { class: "ConfigError", reason: "cached-short-circuit" };
  }
};

/** Owned payload schemas (Codex P2). admission events are written exclusively
 *  by this module, so any shape mismatch read back is infra corruption —
 *  same failure path as quota's malformed-payload defense
 *  (quota-service.ts:97). Schema.decodeUnknownSync throws → Effect.try wraps
 *  as SqlError; no silent `undefined.x` defect leaks through projectLease.
 */
const AttemptKeySchema = Schema.Struct({
  routeFingerprint: Schema.String,
  schemaFingerprint: Schema.String,
  strategy: Schema.Literal("forced-tool-call"),
  adapterVersion: Schema.String,
});

const OutcomeSchema = Schema.Union(
  Schema.Struct({ class: Schema.Literal("Supported"), tokensUsed: Schema.Number }),
  Schema.Struct({
    class: Schema.Literal("ProviderRejected"),
    status: Schema.Number,
    body: Schema.String,
  }),
  Schema.Struct({ class: Schema.Literal("SchemaUnsupported"), reason: Schema.String }),
  Schema.Struct({ class: Schema.Literal("BehaviorFailed"), sampleDigest: Schema.String }),
  Schema.Struct({ class: Schema.Literal("AuthError"), status: Schema.Number }),
  Schema.Struct({
    class: Schema.Literal("RateLimited"),
    retryAfterMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ class: Schema.Literal("TransientError"), cause: Schema.String }),
  Schema.Struct({ class: Schema.Literal("ConfigError"), reason: Schema.String }),
);

const EvidencePayloadSchema = Schema.Struct({
  key: AttemptKeySchema,
  stimulusKind: Schema.Literal("probe", "live"),
  outcome: OutcomeSchema,
  admissionImpact: Schema.Literal("lease-bearing", "reinforcement"),
  // adapterId is metadata; ignored by projection. Optional for forward-compat.
  adapterId: Schema.optional(Schema.String),
});
const decodeEvidencePayloadSync = Schema.decodeUnknownSync(EvidencePayloadSchema);

const InvalidatePayloadSchema = Schema.Struct({
  // Barriers carry a Partial<AttemptKey> (wildcarded keys allowed per §8.1),
  // so every field of the inner key is optional.
  key: Schema.Struct({
    routeFingerprint: Schema.optional(Schema.String),
    schemaFingerprint: Schema.optional(Schema.String),
    strategy: Schema.optional(Schema.Literal("forced-tool-call")),
    adapterVersion: Schema.optional(Schema.String),
  }),
  reason: Schema.String,
  by: Schema.String,
});
const decodeInvalidatePayloadSync = Schema.decodeUnknownSync(
  InvalidatePayloadSchema,
);

const loadAdmissionRows = (
  sql: SqlStorage,
  scope: string,
): Effect.Effect<ReadonlyArray<AdmissionRow>, SqlError> =>
  Effect.try({
    try: () => {
      const raw = sql
        .exec(
          "SELECT id, ts, kind, payload FROM events WHERE scope = ? AND (kind = 'llm.structured.evidence' OR kind = 'llm.structured.invalidate') ORDER BY id",
          scope,
        )
        .toArray();
      const out: AdmissionRow[] = [];
      for (const r of raw) {
        const id = Number(r.id);
        const ts = Number(r.ts);
        const kind = String(r.kind);
        const parsed = JSON.parse(String(r.payload)) as unknown;
        if (kind === "llm.structured.evidence") {
          const ev = decodeEvidencePayloadSync(parsed);
          out.push({
            id,
            ts,
            kind: "llm.structured.evidence",
            key: ev.key,
            stimulusKind: ev.stimulusKind,
            outcome: ev.outcome as Outcome,
            admissionImpact: ev.admissionImpact,
          });
        } else if (kind === "llm.structured.invalidate") {
          const inv = decodeInvalidatePayloadSync(parsed);
          out.push({
            id,
            ts,
            kind: "llm.structured.invalidate",
            key: inv.key,
          });
        }
      }
      return out;
    },
    catch: (cause) => new SqlError({ cause }),
  });

export const AdmissionLive = (
  ctx: DurableObjectState,
): Layer.Layer<Admission, never, EventBus | AiBinding> =>
  Layer.scoped(
    Admission,
    Effect.gen(function* () {
      const sql = ctx.storage.sql;
      const bus = yield* EventBus;
      const ai = yield* AiBinding;

      const attemptStructured = <O>(
        spec: AttemptSpec<O>,
      ): Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const adapterMode = spec.adapterMode ?? "production";
          const now = yield* Clock.currentTimeMillis;
          const key: AttemptKey = {
            routeFingerprint: routeFingerprint(spec.route),
            schemaFingerprint: spec.schemaContract.fingerprint,
            strategy: spec.strategy,
            adapterVersion: cfAiBindingAdapter.version,
          };

          // Step 2: project lease.
          const rows = yield* loadAdmissionRows(sql, spec.scope);
          const { lease: preLease, latestBarrierTs } = projectLease(
            rows,
            key,
            now,
          );

          // Step 3: gate.
          if (
            preLease.status === "unsupported" &&
            now < preLease.retryAfter
          ) {
            return {
              ok: false,
              outcome: reconstructOutcomeFromLease(preLease),
              lease: preLease,
              admissionImpact: "lease-bearing" as const,
              shortCircuited: true,
            };
          }

          // Step 4: encode (pure).
          const adapterStim =
            spec.stimulus.kind === "live"
              ? { kind: "live" as const, userInput: spec.stimulus.userInput }
              : { kind: "probe" as const, synthetic: spec.stimulus.synthetic };
          const req = cfAiBindingAdapter.encode(
            spec.route,
            spec.schemaContract,
            adapterStim,
            spec.strategy,
          );

          // Step 5-6: call provider + decode (or classify error).
          const rawEither = yield* Effect.either(
            Effect.tryPromise({
              try: () =>
                (
                  ai as { run: (m: string, p: unknown) => Promise<unknown> }
                ).run(req.model, req.body),
              catch: (cause) => cause,
            }),
          );

          let outcome: Outcome;
          let decoded: DecodedOutput | undefined;

          if (rawEither._tag === "Left") {
            outcome = cfAiBindingAdapter.classify(rawEither.left);
          } else {
            const d = cfAiBindingAdapter.decode(
              { raw: rawEither.right },
              spec.schemaContract,
              spec.strategy,
              adapterMode,
            );
            if (d.ok) {
              decoded = d.decoded;
              const usage = (rawEither.right as { usage?: { total_tokens?: number } }).usage;
              outcome = { class: "Supported", tokensUsed: usage?.total_tokens ?? 0 };
            } else {
              outcome = d.outcome;
            }
          }

          // Step 7: admission impact from pre-call inputs only.
          const admissionImpact = decideTier(
            preLease,
            outcome,
            spec.stimulus.kind,
            latestBarrierTs,
          );

          // Step 8: pre-stringify payloads outside the transaction.
          const evidencePayload = {
            key,
            stimulusKind: spec.stimulus.kind,
            outcome,
            admissionImpact,
            adapterId: `cf-ai-binding@${cfAiBindingAdapter.version}`,
          };
          const evidenceStr = yield* safeStringify(evidencePayload);

          let deliverSpec: DeliverSpec | null = null;
          let deliverStr: string | null = null;
          if (
            outcome.class === "Supported" &&
            spec.stimulus.kind === "live" &&
            decoded !== undefined
          ) {
            deliverSpec = spec.stimulus.deliver(decoded as O);
            deliverStr = yield* safeStringify(deliverSpec.payload);
          }

          // Step 8b: transactionSync(evidence + optional deliver).
          const txResult = yield* Effect.try({
            try: () =>
              ctx.storage.transactionSync(() => {
                const c1 = sql.exec(
                  "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                  now,
                  "llm.structured.evidence",
                  spec.scope,
                  evidenceStr,
                );
                const evidenceId = Number(c1.one().id);

                let deliverId: number | undefined;
                if (deliverSpec !== null && deliverStr !== null) {
                  const c2 = sql.exec(
                    "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                    now,
                    deliverSpec.event,
                    spec.scope,
                    deliverStr,
                  );
                  deliverId = Number(c2.one().id);
                }
                return { evidenceId, deliverId };
              }),
            catch: (cause) => new SqlError({ cause }),
          });

          // Step 9: fire events after commit.
          const evidenceEvent: LedgerEvent = {
            id: txResult.evidenceId,
            ts: now,
            kind: "llm.structured.evidence",
            scope: spec.scope,
            payload: evidencePayload,
          };
          yield* bus.fire(evidenceEvent);

          if (
            deliverSpec !== null &&
            txResult.deliverId !== undefined &&
            deliverStr !== null
          ) {
            yield* bus.fire({
              id: txResult.deliverId,
              ts: now,
              kind: deliverSpec.event,
              scope: spec.scope,
              payload: deliverSpec.payload,
            });
          }

          // Post-projection (read-only, for the return value's lease shape).
          const postRows = yield* loadAdmissionRows(sql, spec.scope);
          const { lease: postLease } = projectLease(postRows, key, now);

          if (outcome.class === "Supported" && decoded !== undefined) {
            return {
              ok: true,
              decoded: decoded as O,
              outcome,
              lease: postLease,
              admissionImpact,
              shortCircuited: false,
            };
          }
          return {
            ok: false,
            outcome,
            lease: postLease,
            admissionImpact,
            shortCircuited: false,
          };
        });

      const invalidate = (
        spec: InvalidateSpec,
      ): Effect.Effect<{ readonly barrierId: number }, SqlError | JsonStringifyError> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const payload = {
            key: spec.key,
            reason: spec.reason,
            by: spec.by,
          };
          const payloadStr = yield* safeStringify(payload);

          const id = yield* Effect.try({
            try: () => {
              const cursor = sql.exec(
                "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                now,
                "llm.structured.invalidate",
                spec.scope,
                payloadStr,
              );
              return Number(cursor.one().id);
            },
            catch: (cause) => new SqlError({ cause }),
          });

          yield* bus.fire({
            id,
            ts: now,
            kind: "llm.structured.invalidate",
            scope: spec.scope,
            payload,
          });

          return { barrierId: id };
        });

      return { attemptStructured, invalidate };
    }),
  );
