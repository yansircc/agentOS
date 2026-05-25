# Spec 25: LLM Admission & Structured Output

> **Status**: Draft v0 (drafted 2026-05-25)
> **Relates to**: [spec-24-invariants-and-surface.md](./spec-24-invariants-and-surface.md), [spec-24-symphony-comparison.md](./spec-24-symphony-comparison.md)
> **Supersedes**: spec-24 §6.2 (`withStructuredOutput`, deferred from v1 MVP)
> **Falsified prior design**: [spikes/03-structured-output/README.md](../spikes/03-structured-output/README.md) — `response_format: json_schema` is not contractually honored by Workers AI

---

## 0. Purpose

Structured-output capability is not a model attribute and not a configuration
declaration. It is **evidence**: a route, under a schema contract, with a
strategy, executed via an adapter version, that has been observed to produce
a schema-conforming output.

agent-OS treats this evidence the same way it treats every other piece of
state — as a ledger fact. "lease" / "registry" / any cache is a projection,
not a source of truth (see [spec-24 §3.1](./spec-24-invariants-and-surface.md#31-ssot-discipline-derived-from-symphony-comparison)).

This spec defines the minimum algebra and event vocabulary to make that
discipline executable. It does **not** introduce a model whitelist, a
capability table, or any provider-specific surface in the core algebra.

---

## 1. Invariant

> **Structured-output capability is not a model attribute. It is a projection
> over `llm.structured.evidence` ledger events, keyed by
> `(route, schemaContract, strategy, adapterVersion)`.**

Corollaries:

- **C-1**. No persisted lease/registry/KV may exist as a separate writer.
  Any cache must be reconstructable from `events`.
- **C-2**. "supported" is never a static declaration; it is the latest
  evidence projection for the given key, with a TTL determined by the
  failure class of the most recent contradicting evidence.
- **C-3**. Admission is an algebraic precondition for `attemptStructured`,
  not a governance afterthought. The admission decision is **derived** from
  evidence, not stored alongside it.

### 1.1 Scope boundary — what admission does NOT cover

Admission gates **LLM-produced structured claims**. It does NOT gate:

- `AgentDOBase.emitEvent(spec)` — the now-write primitive added in
  v0.2.10. emitEvent writes app-observed facts directly to the ledger
  (e.g., HTTP POST /answer → `emitEvent("interview.answer")`). These are
  **not LLM outputs** and have no schema contract, no provider, no
  capability question. Admission has nothing to gate.
- `submit(spec)` without `outputSchema` — the free-text agent loop.
  Tool calls inside that loop go through quota (spec-24 §6.1), not
  admission. Admission only activates when `submit({outputSchema})` is
  the requested shape.

emitEvent and admission are different generators with different
invariants. emitEvent reads as: "I (the app) observed this fact, record
it." `submit({outputSchema})` reads as: "I (the LLM) claim this typed
object is a valid response; admission decides whether the route is
trusted to produce it."

Conflating them would either (a) force every external HTTP POST through
a capability gate it doesn't need, or (b) let the LLM author untyped
facts that bypass admission. The boundary is structural, not stylistic.

---

## 2. SSoT placement

Same discipline as quota (spec-24 §3.1):

| Concept | Placement | SSoT? |
|---|---|---|
| `llm.structured.evidence` ledger event | DO SQLite `events` table (admission impact tagged per §10) | **yes** |
| `CapabilityLease` | pure projection over `events` | no |
| In-memory lease cache | optional memoization; reconstructable from events | no |
| Per-route counters / SLO stats | projection | no |

A second writer for capability state is a spec violation. Adding a `leases`
table, KV namespace, or Durable Object property that holds capability truth
breaks C-1.

---

## 3. Route — tagged union of transport protocols

A route declares the **protocol**, not just the URL. The same endpoint URL
may speak different protocols; the URL cannot determine carrier shape.

```ts
type LlmRoute =
  | { kind: "cf-ai-binding";          modelId: string; gateway?: GatewayRef }
  | { kind: "openai-chat-compatible"; endpointRef: EndpointRef; modelId: string }
  | { kind: "openai-responses";       endpointRef: EndpointRef; modelId: string }
  | { kind: "anthropic-messages";     endpointRef: EndpointRef; modelId: string }
  | { kind: "gemini-generate-content";endpointRef: EndpointRef; modelId: string };
```

- `EndpointRef` is a stable symbolic id (resolved from config / secrets at
  call time); it is **not** a raw URL. Two endpoints with identical URLs but
  different protocol semantics MUST resolve to different `EndpointRef`.
- `kind` enumerates **protocols**. Protocols are finite. Models are not.
- `routeFingerprint = "route-json-v1:" + canonicalJson({ kind, endpointRef, modelId, gatewayRef? })`.
  A canonical-JSON string, **not** a hash. Hashing was attempted with
  32-bit FNV-1a in the v0.2.10 first implementation and rejected after
  Codex P1 review surfaced a real collision
  (`@cf/3hwlz7pq9l` vs `@cf/x3qxkshczh`). The SSoT key for capability
  cannot be probabilistic — distinct routes MUST yield distinct keys
  by construction. Canonical JSON is collision-free, and routes are
  small enough (~80 chars) that the size cost is negligible.

Runtime enablement (which `kind` values are wired to a live adapter) is a
separate concern — see §11.

---

## 4. Schema contract & fingerprint

A `SchemaContract` is the structural specification an output must satisfy:

```ts
type SchemaContract = {
  schema:      JsonSchemaObject;   // closed dialect; public RPC boundary
  fingerprint: string;             // see §4.1
};
```

`JsonSchemaObject` is a narrow dialect of JSON Schema:
`{ type: "object", properties, required?, additionalProperties? }` with
primitives `string` (optional `enum`), `number`, `boolean`, nested
`object`, and `array` (with `items`). See `packages/core/src/admission.ts`
for the exact type.

Rationale for keeping the public type at JSON Schema, not
`effect/Schema`:

- spec-24 §14.2 forbids leaking Effect TS into the substrate's public
  surface. `Schema.Schema<O>` on `SubmitSpec` would push EFF rules into
  app-side type bounds.
- Apps that want typed `Schema.Type<O>` work convert at the boundary:
  use `JSONSchema.make(EffectSchema)` to produce the
  `JsonSchemaObject` for `submit.outputSchema`, then decode the deliver
  event payload through the same Effect Schema in the `on()` handler.
- An earlier draft of this spec exposed
  `schema: Schema.Schema<unknown>` and a `decoder` field on
  `SchemaContract`. That design was **rejected** by Codex P3 review
  during v0.2.10 integration — it would mislead the next implementer
  into reintroducing Effect at the RPC boundary. Recorded here so the
  decision is durable.

### 4.1 Canonical fingerprint algorithm

`fingerprint` MUST be deterministic across equivalent schemas. The algorithm:

1. Treat the input as the JSON Schema tree directly (no Effect Schema
   lowering at the substrate boundary). Apps that want effect/Schema
   typing call `Schema.JSONSchema.make(EffectSchema)` on their side
   before passing the result into `submit.outputSchema`.
2. Canonicalize the JSON tree:
   a. Sort object keys lexicographically (recursive).
   b. Inline `$ref` (no remote refs allowed; reject at compile time).
   c. Normalize `nullable` / `optional` / union representations to a single
      canonical form (concrete form defined by the implementing adapter
      package, but must be deterministic).
   c'. **Sort set-semantics arrays.** JSON Schema fields whose value is an
      array semantically representing a set (no ordering meaning) MUST be
      sorted lexicographically before serialization. The closed set of
      such fields is `{"required", "enum"}`. Adding a new entry to this
      set is a fingerprint algorithm version bump (§16). Discovered during
      spike-04 — see [spikes/04-llm-admission/README.md](../spikes/04-llm-admission/README.md#verdict).
   d. Strip non-semantic annotations (`title`, `description`, `examples`,
      vendor `x-*`).
3. Serialize via deterministic JSON (canonical-json-rs equivalent).
4. `fingerprint = "<algoVersion>:sha256:" + sha256(canonicalJson)`
   where `algoVersion` is a string identifying the canonicalization
   algorithm + the Effect Schema lowering version (initial value:
   `"effect-json-schema-v1"`).

Embedding the algorithm version inside the fingerprint string means that
a canonicalization change (§16) automatically yields fingerprints that
do not collide with prior evidence — the version bump *is* the eviction
mechanism, no separate `canonicalVersion` field is needed in the key.

Implementations MUST ship a fingerprint compatibility test covering:
- key reordering invariance
- optional/nullable equivalence
- nested array / union edge cases
- `$ref` resolution

A fingerprint mismatch across implementations of agent-OS is a bug, not a
feature. Two agent-OS deployments looking at the same schema MUST produce
the same fingerprint.

### 4.2 Out of scope for v0

- Streaming partial schemas
- Schemas with runtime-resolved `$ref`
- Provider-specific schema extensions (function modifiers, etc.)

---

## 5. Stimulus — tagged union of admission triggers

`attemptStructured` is one algebra op invoked under two stimulus kinds.
Distinguishing them in the evidence event is required so projections can
weight probe evidence (systematic, low-volume) vs live evidence
(distributional, high-volume) differently.

```ts
type DeliverSpec = {
  event:   EventName;     // ledger event kind
  payload: unknown;       // payload to append alongside the evidence event
};

type Stimulus =
  | { kind: "probe"; synthetic: ProbeInput }
  | { kind: "live";  userInput: LiveInput; deliver: (out: DecodedOutput) => DeliverSpec };
```

- `probe`: synthetic input designed to exercise the schema. The
  `DecodedOutput`, if any, is discarded after evidence emission.
- `live`: real user input. On success, `deliver(decoded)` is a **pure
  function returning a data record**, NOT an arbitrary Effect.
  `attemptStructured` writes both the evidence event and the
  deliver event in the **same `transactionSync` block** on DO SQLite (§7).
  Side-effecting handlers run via the normal `on()` subscription after
  commit, never inside the transaction.

Restricting `deliver` to a pure function preserves the atomicity invariant:
"evidence written iff deliver written iff downstream consumers see the
output". An arbitrary `Effect.Effect<void, never, R>` cannot be enrolled
in DO SQLite's synchronous transaction; allowing it would silently break
atomicity under failure.

Evidence event payload carries `stimulusKind ∈ {"probe", "live"}`.

---

## 6. Adapter law — pure protocol translation

An `Adapter` per route `kind` is a **set of three pure functions**. IO is
not in the adapter; IO is in `attemptStructured`.

```ts
interface Adapter<K extends LlmRoute["kind"]> {
  readonly kind:           K;
  readonly version:        SemverString;            // §9

  encode(
    route:         Extract<LlmRoute, { kind: K }>,
    schema:        SchemaContract,
    stimulus:      Stimulus,
    strategy:      Strategy,
  ): ProviderRequest;

  decode(
    response:      ProviderResponse,
    schema:        SchemaContract,
    strategy:      Strategy,
  ): Effect.Effect<DecodedOutput, BehaviorFailed | SchemaUnsupported>;

  classify(
    error:         unknown,
  ): FailureClass;
}
```

- `encode` is pure: route + schema + stimulus + strategy → request payload.
  No IO, no clock, no secrets resolution (secret resolution happens in the
  transport layer above the adapter).
- `decode` is an Effect (per EFF001/024/025); `BehaviorFailed`/`SchemaUnsupported`
  are `Data.TaggedError` subclasses (spec-24 §14.1).
- `classify` maps low-level transport / HTTP / protocol-level errors into
  the closed `FailureClass` set (§8).
- Adapters MUST be unit-testable without network access.

`Strategy` per kind is closed (no free-form strings). For `cf-ai-binding`:

```ts
type Strategy = "forced-tool-call";
// other route kinds extend this union under their own namespace
```

Only `forced-tool-call` is supported for `cf-ai-binding` (spike-03 verdict).
Other strategies are not enabled until a new spike justifies them.

---

## 7. Core algebra

Two ops only.

### 7.1 `attemptStructured` — IO-bearing, evidence-producing

```ts
type AttemptKey = {
  routeFingerprint:  string;     // §3
  schemaFingerprint: string;     // §4.1
  strategy:          Strategy;
  adapterVersion:    SemverString;
};

type StructuredEvidence = {
  key:           AttemptKey;
  stimulusKind:  "probe" | "live";
  outcome:       Outcome;
  ts:            number;         // Clock.currentTimeMillis
  adapterId:     string;         // for cross-deployment trace
  // payload details vary per Outcome class
};

type Outcome =
  | { class: "Supported"; tokensUsed: number }
  | { class: "ProviderRejected";  status: number; body: string }
  | { class: "SchemaUnsupported"; reason: string }
  | { class: "BehaviorFailed";    sampleDigest: string }
  | { class: "AuthError";         status: number }
  | { class: "RateLimited";       retryAfterMs?: number }
  | { class: "TransientError";    cause: string }
  | { class: "ConfigError";       reason: string };

attemptStructured(
  route:    LlmRoute,
  schema:   SchemaContract,
  stimulus: Stimulus,
  strategy: Strategy,
): Effect.Effect<DecodedOutput, FailureClassError, Adapter | Ledger | Clock | AiBinding | Http>
```

Algorithm:

```
1. key = makeKey(route, schema, strategy, adapter.version)
2. lease = projectLease(events, key, now)         // §7.2
3. gate decision:
     a. lease.status == "supported" and not expired   → proceed
     b. lease.status == "unsupported" and not expired → fail with the
        cached FailureClass, do NOT call provider
     c. lease missing/expired                          → proceed (this call
        IS the admission probe)
4. providerRequest = adapter.encode(route, schema, stimulus, strategy)
5. providerResponse = transport.send(route, providerRequest)
     on transport error → outcome = adapter.classify(error)
6. on success:
     decoded = adapter.decode(response, schema, strategy)
     outcome = decoded ? Supported : (failure class from decode)
7. determine evidence admission-impact (§10):
     admissionImpact = decideImpact(preLease /* from step 2 */,
                                    outcome,
                                    stimulus.kind,
                                    latestBarrierCursor /* from step 2; (ts,id) tuple */)
   — `admissionImpact` MUST be computed from inputs available BEFORE the
     append. Do NOT call `projectLease` again after step 8 to decide it —
     that introduces a redundant scan and a race against concurrent
     appends. The decision is a pure function of
     `(preLease, outcome, stimulusKind, latestBarrierCursor)`.
8. open DO SQLite transactionSync:
     a. append evidence event (admissionImpact tag from step 7)
     b. if outcome.class == "Supported" and stimulus.kind == "live":
          spec = stimulus.deliver(decoded)            // pure call
          append spec.event with spec.payload
     commit
9. after commit:
     if outcome.class == "Supported": return decoded to caller
     else: fail with the matching FailureClassError
     `on()` subscribers fire from the commit, not from inside it.
```

Steps 8a and 8b commit together. `stimulus.deliver` is a pure function
(§5); no foreign Effect runs inside the transaction. EventBus handlers
attached via `on()` are invoked by the ledger primitive **after** commit,
which is the normal spec-24 §5.1 behavior — no special-casing needed.

### 7.2 `projectLease` — pure projection

```ts
type CapabilityLease =
  | { status: "supported";   pinnedStrategy: Strategy; validUntil: number; lastEvidenceTs: number }
  | { status: "unsupported"; failureClass: Exclude<Outcome["class"], "Supported">; retryAfter: number; lastEvidenceTs: number }
  | { status: "unknown" };   // no evidence yet, OR all evidence expired

projectLease(
  events: ReadonlyArray<StructuredEvidence | InvalidateBarrier>,
  key:    AttemptKey,
  now:    number,
): CapabilityLease
```

- Pure function. No IO. `now` is supplied by the caller (from
  `Clock.currentTimeMillis` per EFF026/032).
- **Total order**: each ledger row has a unique `(ts, id)` pair where
  `id` is a SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`. Projection uses
  `(ts, id)` lexicographic ordering everywhere (latest evidence, barrier
  cutoff). Same-millisecond rows are resolved by `id` ascending — the
  later writer wins. Implementations MUST NOT use `ts` alone, since
  multiple events can land in the same millisecond and `ts >`/`ts <=`
  becomes ambiguous (this was a Codex-reported P1 in the first
  implementation; fixed before LGTM).
- Selection rule: among events matching `key`, take the latest event
  (by `(ts, id)`) whose effective TTL (relative to `now`) has not
  elapsed.
- Any `llm.structured.invalidate` barrier event with matching key
  (§8.1) **discards all evidence strictly earlier than the barrier
  under `(ts, id)` order**. Projection resumes from the next evidence
  after the barrier.
- If the latest evidence is `TransientError` / `ConfigError` /
  `AuthError` / `RateLimited`, it does NOT define lease status (those
  classes are excluded per §8); fall through to the next-latest
  qualifying evidence.

There is no `registry.store(lease)`. Lease is not stored. Caching the
result of `projectLease` in memory is permitted; persisting it is not.

---

## 8. FailureClass and TTL table

| Class              | Caches as lease? | TTL on cache | Notes |
|---|---|---|---|
| `Supported`        | yes (supported) | soft 24h refresh, hard 7d | hard expiry forces front-stage re-admission |
| `ProviderRejected` | yes (unsupported) | min(7d, until adapter/route/schema change) | provider explicitly says "not supported" |
| `SchemaUnsupported`| yes (unsupported) | min(7d, until schema/adapter change)       | adapter can't `encode` this schema shape |
| `BehaviorFailed`   | yes (unsupported) | start 24h, exponential backoff up to 30d cap, user-invalidate-able | model output didn't conform; behavior is deterministic, short retries are wasted |
| `AuthError`        | **no**           | n/a — fast-fail to operator | not a capability fact |
| `RateLimited`      | **no**           | n/a — handled by transport retry/backoff | not a capability fact |
| `TransientError`   | **no**           | n/a — transport retries | not a capability fact |
| `ConfigError`      | **no**           | n/a — fast-fail to operator | not a capability fact |

The four non-caching classes are explicitly **not** evidence for lease
projection. They still produce `llm.structured.evidence` events for audit
and ops dashboards, but `projectLease` ignores them.

Soft/hard expiry on `Supported`:
- **Soft (24h)**: background re-probe scheduled via `scheduleEvent`; current
  lease stays valid until probe completes.
- **Hard (7d)**: front-stage admission required; cached lease ignored.

Invalidation:
- `attemptStructured` is the only writer of `llm.structured.evidence`
  events. Operators do not modify or forge evidence.
- Operators bump lease projection by appending a distinct event kind
  `llm.structured.invalidate` (§8.1), not by forging a synthetic evidence
  outcome. Reusing `ConfigError` as a side channel was rejected — it
  contradicts both "ConfigError is not a capability fact" and
  "`attemptStructured` is the only evidence writer".

### 8.1 Invalidate barrier

A separate ledger event kind dedicated to lease invalidation:

```ts
type InvalidateBarrier = {
  kind:   "llm.structured.invalidate";
  key:    Partial<AttemptKey>;   // omit fields to invalidate broader scope
  reason: string;
  ts:     number;
  by:     string;                // operator id / admin token tag
};
```

Semantics:

- Writer = admin API only (separate from `attemptStructured`).
- `projectLease` treats a matching barrier as a hard cut-off: all
  evidence for the matched key strictly older than the barrier `ts`
  is ignored.
- Wildcarding via `Partial<AttemptKey>`: e.g. `{ adapterVersion: "1.x" }`
  invalidates everything emitted by 1.x adapters; `{ schemaFingerprint: F }`
  invalidates every route that touched schema F.
- Barrier events are themselves immutable ledger entries — invalidation
  history is auditable.
- Barriers live in DO SQLite (lease-bearing by construction; admission
  impact is always reading them, so they cannot be routed elsewhere).

---

## 9. Adapter version semantics

`adapterVersion` is a Semver string embedded in the adapter module:

```ts
export const cfAiBindingAdapter: Adapter<"cf-ai-binding"> = {
  kind: "cf-ai-binding",
  version: "1.0.0",
  // ...
};
```

Rules:

- Every evidence event records the `adapterVersion` that produced it.
- `projectLease` filters evidence whose `adapterVersion < currentAdapter.version`
  by major version only:
  - **Major bump** (X.0.0): invalidates all prior evidence for this kind.
  - **Minor/patch bump**: evidence remains valid.
- Encoding/decoding behavior changes MUST bump major.
- Cosmetic changes (logging, type signatures with no payload effect) MAY
  bump minor/patch.

This decouples "adapter is improved" from "all leases must re-admit".

---

## 10. Evidence event admission impact

Per spec-24 §10, log tier is a hint. For `llm.structured.evidence` the
classification is **not** a storage routing decision (v0 has no AE sink —
all rows live in DO SQLite). It is a **lease-impact label** that
`projectLease` reads to decide which rows participate in admission:

| Condition | `admissionImpact` | Rationale |
|---|---|---|
| Outcome is non-Supported AND is a lease-bearing class (§8) | `lease-bearing` | Lease projection must read it; required for admission decisions. |
| Outcome is `Supported` AND prior lease for `key` was `unknown` / hard-expired / barrier-invalidated | `lease-bearing` | This is the admission-forming evidence. |
| Outcome is `Supported` AND prior lease was already `supported` (within hard expiry, no intervening barrier) | `reinforcement` | High-volume confirmation; ignored by `projectLease`. |
| Outcome class is `AuthError` / `RateLimited` / `TransientError` / `ConfigError` | `lease-bearing` | Required for ops dashboards even though not lease-bearing for projection. |
| Stimulus is `probe` | `lease-bearing` (regardless of outcome) | Systematic, low volume, canonical input to `projectLease`. |
| `llm.structured.invalidate` barrier events (§8.1) | n/a | Barriers have no `admissionImpact` field; always lease-bearing by construction. |

Principle: **any evidence that can change `projectLease` output is tagged
`lease-bearing`**. Reinforcement rows are still appended to the ledger
(observability + future migration to a separate sink) but `projectLease`
filters them out.

The decision is made inside `attemptStructured` step 7 (§7.1) by comparing
the about-to-emit outcome against the pre-call `lease.status`. **MUST be
computed from inputs available BEFORE the append**: `(preLease, outcome,
stimulusKind, latestBarrierCursor)`. Do NOT derive by re-projecting after
the append. Two reasons:

1. **Determinism**: re-projecting introduces a race with concurrent
   appends on the same key — the new evidence could already be visible
   to the second `projectLease`, making the impact label dependent on
   ordering rather than on the call's own outcome.
2. **Cost**: an extra full-key scan per call is wasteful when the
   required inputs were already read in step 2.

### 10.1 Future: separate AE sink

When traffic justifies it, `reinforcement`-tagged evidence can be routed
to Analytics Engine (or any append-only sink) instead of DO SQLite,
shrinking the OLTP working set. v0 keeps all rows in DO for simplicity
and observability. The `admissionImpact` label is the routing key the
sink reads; no further spec change is needed when wiring the sink.

> **History note**: spec-25 v0 (pre-2026-05-25) called this field `tier`
> with values `"do-sqlite" / "analytics-engine"`. That naming implied a
> storage tier; in v0 it was actually a projection filter. Renamed to
> match implementation reality. See Appendix B in
> `spec-24-symphony-comparison.md` for the bigger picture of "label vs
> location" boundary errors.

---

## 11. Enabled subset (initial)

`LlmRoute` enumerates five protocol kinds (§3). Runtime adapter registry
initially registers exactly one:

```ts
adapters = new Map<LlmRoute["kind"], Adapter<any>>([
  ["cf-ai-binding", cfAiBindingAdapter],
  // openai-chat-compatible:  pending (custom endpoint + secret + BYOK boundary)
  // openai-responses:        pending
  // anthropic-messages:      pending
  // gemini-generate-content: pending
]);
```

`attemptStructured` on an unregistered `kind` fails at entry with
`ConfigError({ reason: "transport_not_enabled" })`. The algebra remains
total; only the adapter table is partial.

Adding the second transport (likely `openai-chat-compatible` for
OpenRouter / self-hosted / AI Gateway BYOK) requires a separate PR that
also defines:
- `EndpointRef` resolution from secrets
- Quota ownership per endpoint
- Cost / billing attribution
- Per-endpoint audit policy

This PR is **out of scope** for spec-25 v0. See §15.

---

## 12. Public surface

### 12.1 `submitAgent` integration

```ts
submitAgent({
  intent:        "...",
  context:       { ... },
  agent:         { provider: "@cf", model: "openai/gpt-oss-120b" },
  tools:         {},                          // mutually exclusive with
                                              // outputSchema in v0.2.10
  budget:        { ... },
  outputSchema?: JsonSchemaObject,            // optional, triggers admission
  deliver:       { event: "..." },
}): Promise<SubmitResult>
```

When `outputSchema` is present:

1. The multi-turn tool loop is **bypassed**. The submit goes through a
   single `attemptStructured` call.
2. Internally, the adapter (`cf-ai-binding`) synthesizes a
   `_submit_structured` tool whose `parameters` is the canonical schema,
   and forces `tool_choice` to that tool.
3. The decoded args become the run's structured output.
4. `submitAgent` constructs `stimulus.deliver = (decoded) => ({ event: deliver.event, payload: decoded })`.
   `attemptStructured` writes the evidence event and the deliver event
   in one DO SQLite `transactionSync` (§7.1 step 8). Consumers subscribed
   via `on(deliver.event, handler)` receive the decoded payload after
   commit.

When `outputSchema` is absent: standard multi-turn tool loop, identical
to current spec-24 behavior. No admission, no evidence.

**v0.2.10 constraint**: `outputSchema` and a non-empty `tools` map are
mutually exclusive — supplying both triggers an `agent.aborted.upstream_failure`
abort with reason `output_schema_excludes_tools_in_v0_2_10`. Mixing the
two (multi-turn tool loop terminating in structured output) is deferred
until a real app needs it.

#### Why JsonSchemaObject and not `Schema.Schema<O>` on the public API

The substrate's public API is plain TS/Promise (spec-24 §14.2 boundary
translation rule). Exposing `effect/Schema` on `SubmitSpec` would force
EFF rules into the app-side type surface, which is exactly what spec-24
§14 forbids. Apps that want effect/Schema typing wrap their own helper:

```ts
// app-side, not in core
const PlanSchema = Schema.Struct({ ... });
const jsonSchema = JSONSchema.make(PlanSchema);     // effect/Schema → JsonSchemaObject
const result = await agent.submit({
  outputSchema: jsonSchema as JsonSchemaObject,
  // ...
});
const decoded: Schema.Schema.Type<typeof PlanSchema> =
  Schema.decodeUnknownSync(PlanSchema)(deliverPayload);
```

The substrate is responsible for: canonical fingerprint, capability
lease, transactional commit. The app is responsible for: typing the
deliver payload after it lands in the handler.

### 12.1.1 Return shape

`submitAgent`'s return type is `Promise<SubmitResult>` per spec-24 §5.2.
On the `outputSchema` path:

- `ok: true` → `SubmitResult.final` is a JSON string (the stringified
  decoded output, for backward compatibility with the free-text path
  where `final` is the LLM's text).
- The structured/typed payload is delivered through the `on(deliver.event,
  handler)` callback whose `payload` argument is the raw decoded object
  (already validated against the JSON Schema during decode). Apps that
  need a typed view convert via their own Effect Schema decoder as shown
  above.
- `ok: false` → SubmitResult.reason is `"upstream_failure"`; the abort
  ledger event payload carries `outcomeClass`, `shortCircuited`,
  `admissionImpact`, and the `lease` projection at the time of the
  decision.

This preserves the spec-24 invariant that `submitAgent` is
fire-and-track, not request-response — and avoids divergent return
shapes when `outputSchema` is/isn't supplied.

### 12.2 Direct admission API (advanced)

```ts
agentOS.llm.probe(
  route:    LlmRoute,
  schema:   SchemaContract,
  strategy: Strategy,
): Promise<StructuredEvidence>
```

For CI matrix warmup and operator-driven validation. Internally calls
`attemptStructured` with `stimulus.kind = "probe"` and discards
`DecodedOutput`.

---

## 13. Impact on existing product

| Surface | Impact |
|---|---|
| Free-text `submitAgent` (no `outputSchema`) | **None.** Existing loop path unchanged. |
| `packages/core/src/llm.ts` `callLlm` | Retained as the transport primitive consumed by `attemptStructured` internally. Not exposed in public API. |
| `withStructuredOutput` middleware (spec-24 §6.2) | Remains deferred; replaced by `submit.outputSchema` per this spec. |
| Ledger schema | Adds `llm.structured.evidence` event kind. No migration needed (events table is open-schema). |
| `view.reflective.*` | New view: `view.reflective.structuredCapability(key)` returns `CapabilityLease`. Not in §5.1 of spec-24; additive. |
| Examples in spec-24 §16 | Img-Gen (§16.3) currently uses `withStructuredOutput(llmCarrier, PlanSchema)`. Should be rewritten to `submitAgent({ ..., outputSchema: PlanSchema })` once spec-25 lands. |
| Dependencies | No new runtime deps. Canonical-JSON for fingerprint is implementable in ~50 LOC. |

No breaking change to current dogfood code. The change is purely additive
until §12.1 example rewrites land.

---

## 14. Spike plan revision

spec-24 §15 spike-04 was "anthropic-via-openai-compat". This spec changes it:

| Spike | Old definition | New definition |
|---|---|---|
| spike-04 | anthropic-via-openai-compat (transport unification feasibility) | **lease registry on `cf-ai-binding`** — validates §7 + §8 + canonical fingerprint stability over real traffic |
| spike-04b (new) | n/a | anthropic-messages adapter — exercises §6 adapter law on a non-OpenAI-shaped protocol; validates that `encode/decode/classify` are sufficient |
| spike-04c (new, deferred) | n/a | gemini-generate-content adapter — same goal, third protocol shape |

spike-05 (Session API compaction) and spike-06 (AutoRAG) are unchanged.

---

## 15. Open questions

1. **[Open] Canonical JSON Schema lowering across Effect Schema versions.**
   `Schema.JSONSchema.make` is stable for v3 but emit format may shift in
   minor releases. Pinning + a fingerprint compatibility test (§4.1)
   protects this, but cross-Effect-version migration may require a
   fingerprint algorithm version bump (separate from `adapterVersion`).

2. **[Open] Cross-DO lease sharing.** `events` is per-DO. A `cf-ai-binding`
   route + schema combo proved on DO-A is not visible to DO-B unless events
   are forwarded. Options: a shared "global capability ledger" DO (single
   instance addressed by route-kind), or per-DO independent admission.
   Per-DO is simpler and safer (no cross-tenant capability leak); global
   is more efficient. Decision deferred until N≥2 apps observe redundant
   admission cost.

3. **[Open] Probe stimulus authoring.** §5 says probe uses "synthetic
   input designed to exercise the schema". Who authors it? Options:
   (a) the adapter ships a stock probe generator from the schema;
   (b) the user supplies a `probe` field on `SchemaContract`;
   (c) auto-generate via Effect Schema arbitraries.
   Likely (a) + (b) override; finalized when first probe-only use case
   appears.

4. **[Open] `BehaviorFailed` quarantine vs invalidation by model release.**
   When CF Workers AI updates a model image, `BehaviorFailed` evidence
   should expire even within its 24h–30d TTL. Detection mechanism: model
   card hash, response header version, or scheduled probe refresh. No
   reliable signal exists today on `cf-ai-binding`; fallback is the soft
   refresh at 24h.

5. **[Open] BYOK / custom endpoint boundary.** Enabling the second
   transport requires: secret storage primitive, per-endpoint quota
   ownership, cost attribution, audit policy. None of these belong in
   spec-25. They are a separate spec when justified by a real app.

6. **[Open] Adapter strategy evolution for flaky-but-not-broken models.**
   spike-04 observed that `@cf/openai/gpt-oss-120b` under
   `forced-tool-call` is not 3/3 reliable as spike-03 claimed — actual
   rate ≈ 60% (3/3) and ≈ 40% (1/3 or 2/3) across trials. One
   `BehaviorFailed` event currently locks the route out for 24h. For a
   model that succeeds in 2 of 3 calls on average, this short-circuit
   may be over-aggressive. Possible directions:
   - adapter-level multi-attempt with internal retries before emitting
     evidence (changes the unit of "one evidence event");
   - lower the TTL floor for `BehaviorFailed` on models tagged as
     "stochastic";
   - introduce a probabilistic lease (e.g. "supported with confidence
     X%") — but this drifts from the boolean lease invariant.
   No change in v0; revisit when an app's metrics warrant.

---

## 16. Versioning

- This is spec-25 v0. Surface frozen for the first implementation cycle.
- Breaking changes to the algebra (§6 / §7) require a new major spec.
- Adding a new `LlmRoute["kind"]` is additive and requires only an
  adapter implementation + spike (no spec bump).
- Changes to fingerprint canonicalization (§4.1) are **always** breaking
  and require a fingerprint algorithm version bump.

---

## Appendix A: Decision provenance

| Decision | Origin |
|---|---|
| Evidence as SSoT, lease as projection | spec-24 §3.1 SSoT discipline applied to a new domain |
| Route as tagged union (5 protocols, not URL) | endpoint URL cannot determine carrier protocol — falsifies "endpoint + model = route" |
| Adapter as pure encode/decode/classify | IO is in `attemptStructured`; adapter is unit-testable in isolation |
| Single algebra op `attemptStructured` + Stimulus | probe and execute are the same op under different stimulus, not two ops |
| `forced-tool-call` as the only v0 strategy on `cf-ai-binding` | spike-03 verdict: `response_format: json_schema` is not honored |
| TTL by failure class, not uniform | `BehaviorFailed` is deterministic; short retry is wasted. `AuthError`/`RateLimited` are not capability facts. |
| Adapter Semver major-only invalidation | decouples adapter polish from lease churn |
| Evidence admission-impact split (lease-bearing vs reinforcement) | admission must read fresh non-success evidence; high-volume Supported reinforcement filters out by projection; future v1 may route reinforcement to AE |
| Initial registry = `cf-ai-binding` only | INV-6 (v1 CF AI only). Custom endpoint / BYOK is a separate spec. |

---

## Appendix B: Anti-patterns explicitly rejected

| Anti-pattern | Reason rejected |
|---|---|
| Maintain a model whitelist table | Models are infinite; protocols are finite. Whitelist = perpetual maintenance burden. |
| Treat `endpoint URL` as route identifier | URL does not determine protocol. Two URLs may speak different shapes; one URL may switch. |
| Persist `CapabilityLease` in KV / D1 / DO property | Second writer of capability truth. Violates C-1. |
| Probe and execute as separate algebra ops | Concept duplication; both are evidence-producing attempts under different stimulus. |
| Uniform unsupported TTL (e.g. "1 month") | Ignores failure-class semantics. `AuthError` is not a capability fact; `BehaviorFailed` is deterministic. |
| Short retry on `BehaviorFailed` | Model behavior is deterministic at fixed weights; sub-day retry wastes calls and pollutes evidence stream. |
| Adapter performs IO directly | Defeats unit testability; mixes protocol translation with transport, secret resolution, and clock. |
| Add `custom endpoint` + BYOK in the same PR as admission | Couples credential storage, quota ownership, billing, and audit into the admission spec. Must be a separate boundary. |
