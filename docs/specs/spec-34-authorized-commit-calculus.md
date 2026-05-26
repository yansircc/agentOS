# Spec 34: Authorized Commit Calculus — Core v0.3 Refactor

> **Status**: Draft v1
> **Date**: 2026-05-26
> **Triggers**: Rebuild `@agent-os/core` public surface as v0.3.0 (breaking).
> **Supersedes (on adoption)**: see §11.
> **Pressure evidence**: convergence dialogue derived from spec-24 §5.1 (4-op
> presentation), spec-32 §1 (modality-named reserved prefix), spec-25 §7
> (admission internals leaked to barrel), spec-31 (submitTextStream as
> kernel-rank method on AgentDOBase).

---

## 0. Purpose

Three failures co-exist in core v0.2.17:

1. **The 4-op presentation hides authority.** spec-24 §5.1 lists
   `ingest / dispatch / log / project` as one tier. The actual invariant is
   not "events can be appended" but "**only the right capability can append a
   given kind**". Forging `dispatch.consumed` collapses quota; forging
   `llm.structured.evidence` collapses admission; forging `resource.reserved`
   double-spends reservations.
2. **Modality leaks to the base class.** `AgentDOBase.generateImage` and
   spec-32's `image.*` reservation burn one specific carrier name into the
   kernel vocabulary. The same shape lurks for any future modality
   (audio/video/web/voice).
3. **Submit internals leak to the top-level barrel.** `CapabilityLease /
   AttemptKey / Outcome / Strategy` and `ProviderRegistryConfig` are
   submit-private machinery. Their public exposure makes `@agent-os/core`
   look like an LLM SDK rather than an event calculus.

v0.3 collapses the three through one move: **make `commit(cap, event)` the
public algebra and define how capabilities are owned**. Once authority is
first-class, modality carriers and submit internals fall out of core by
construction.

---

## 1. Invariant

> **core = authorized commit calculus. Every write into the ledger is
> `commit(cap, event)` where `cap.kindPrefix ⊇ event.kind`. Capability
> ownership is the SSoT discipline, not just blacklist enforcement.**

Corollaries:

- **C-1.** A capability is the unit of write authority. There is no global
  "anyone can append" gate. The v0.2 `emitEvent` blacklist
  (`ReservedEventKindError`) was only a projection of this invariant under
  the old transport, not the invariant itself.
- **C-2.** SSoT discipline is preserved iff every event kind has exactly one
  capability owner. Two owners on the same kind = duplicated truth = INV-5
  violation.
- **C-3.** Composite operations may commit caller-delegated app facts, but only
  when the event kind is still owned by `cap_app` and the composite's public
  spec names that delegation explicitly. This is how `submit.deliver.event`
  and `dispatchToScope.event` land application facts without making submit or
  dispatch the owner of the app namespace.
- **C-4.** Reading does not require capability. `project` and `react` are
  ungated.
- **C-5.** Modalities do not appear in the kernel vocabulary. An image / audio
  / web package obtains its own capability via §7's protocol; core does not
  reserve their namespaces.

---

## 2. Kernel — 5-op authorized commit calculus

Five operations. Non-degenerate: each is a distinct sub-machine.

```ts
// Writes — distinguished by side-effect surface and time axis.

commit(cap, event)              // atomic ledger write; no external effect
effect(cap, intent) => result   // external side-effect, idempotent settlement,
                                //   result settles via commit(cap, result_event)
time(cap, event, at)            // deferred commit; intent buffered now,
                                //   commit performed at `at` via alarm

// Reads — ungated.

project(view, source?)          // bounded query over committed past
react(kind, handler)            // forward subscription over future commits;
                                //   same-scope in v1 (DO isolation)
```

Why not 2 (append + read), why not 4 (the spec-24 inflation):

| Pair                 | Collapsible? | Reason                                                          |
|----------------------|--------------|-----------------------------------------------------------------|
| commit / effect      | no           | effect binds idempotency/outbox sub-machine; commit does not   |
| commit / time        | no           | time writes `scheduled_events` (intent buffer) before commit; different table, different sub-machine |
| project / react      | parameterizable | window axis; v1 keeps two names because react has same-scope transport constraint |
| ingest / dispatch    | yes (internal)  | both are `commit(cap, event)` with different cause; the cause is encoded in the capability holder, not as a kernel parameter |

`ingest` and `dispatch` from spec-24 §5.1 are **internal causation patterns
of `commit`**, not separate kernel ops. They survive as named composites in
§4 (`emitEvent`, `dispatchToScope`) because their authority shape differs.

---

## 3. Capability owners

Six capabilities, four substrate-owned + one app-owned + one higher-order:

| Capability       | Owner                | Write namespace                                            |
|------------------|----------------------|------------------------------------------------------------|
| `cap_dispatch`   | dispatch machinery   | `dispatch.*` (`dispatch.outbound.*`, `dispatch.inbound.*`, `dispatch.consumed`, `dispatch.rate_limited`) |
| `cap_resource`   | resource state       | `resource.*` (`resource.granted`, `resource.reserved`, `resource.reserve_rejected`, `resource.consumed`, `resource.released`) |
| `cap_submit`     | submit lifecycle     | submit-owned run facts: `chat.ingested`, `llm.response`, `tool.executed`, `agent.run.*`, `agent.aborted.*` |
| `cap_admission`  | admission gate       | `llm.structured.*` (`llm.structured.evidence`, `llm.structured.invalidate`) |
| `cap_app`        | app code             | **all kinds not claimed by a substrate or extension cap**  |
| `cap_scheduler`  | scheduler (h-order)  | no own namespace; carries `defer(cap_X, event)` and later promotes via `cap_X`'s authority |

`llm.*` is a shared core prefix with non-overlapping sub-owners:
`cap_submit` owns `llm.response`; `cap_admission` owns `llm.structured.*`.
The runtime claim is intentionally wider than either sub-owner so app writes
cannot forge future `llm.*` facts before a spec assigns the sub-prefix.

Rules:

- **C-1.** `cap_app` is **negatively defined**: any kind not claimed by another
  capability. Apps name their events naturally (`interview.answer`,
  `wa.message.in`, `approval.decided`) — substrate does not impose an
  `app.*` prefix.
- **C-2.** `cap_scheduler` is **higher-order**:
  `cap_scheduler = (cap_X) -> defer(cap_X, event, at)`. It writes
  `scheduled_events` (an internal table, not the ledger) and promotes the
  buffered fact via `cap_X` at fire time. The scheduler holds no ledger
  vocabulary of its own.
- **C-3.** Capabilities are **disjoint by kindPrefix**. Two capabilities
  claiming the same kind = boundary failure, must be rejected at
  registration time.
- **C-4.** Capabilities are **scoped to a DO instance**. Cross-scope writes
  go through `dispatchToScope` (§4), which holds `cap_dispatch` on both
  sides.
- **C-5.** Delegated app-fact commits are not ownership transfer. A composite
  may accept a public `event` field and later commit that event only if
  `event ∈ cap_app`. The composite writes its bookkeeping under its own cap
  and writes the delegated app fact under `cap_app` authority carried in the
  public call. This is the only way a substrate composite may write a
  non-substrate event kind.
- **C-6.** `quota.*` is not a v0.3 vocabulary. Quota settlement is owned by
  `cap_dispatch` through `dispatch.consumed` and `dispatch.rate_limited`.
  Adding a `quota.*` event later requires a spec that assigns it to exactly
  one capability.
- **C-7.** `quota.*` is nevertheless a claimed prefix in v0.3. This is
  `claimed-but-unassigned`: app code cannot write it, and substrate code also
  must not write it until a later spec assigns a real owner.

The v0.3 enforcement surface is `CapabilityRejected`. `ReservedEventKindError`
is removed with the rest of the v0.2 reserved-prefix vocabulary; there is no
compatibility shim.

---

## 4. Shipped composites

Five composites. Each is a named composition of kernel ops with a fixed
capability binding. Apps call composites; kernel ops are internal.

```ts
// emitEvent : app-fact commit
emitEvent(event, data)
  = commit(cap_app, { kind: event, data, ts, scope })

// dispatchToScope : cross-scope effect, idempotent
dispatchToScope(targetScope, intent)
  = effect(cap_dispatch, intent)
    where settlement commits dispatch.* on both sender and receiver scopes
    and receiver commits the requested app event via delegated cap_app

// scheduleEvent : deferred app-fact commit
scheduleEvent(event, data, at)
  = time(cap_app, { kind: event, data }, at)
    = cap_scheduler(cap_app)(event, data, at)

// submit : bounded LLM closed loop
submit(spec)
  = commit(cap_submit, agent.run.started)
    ; commit(cap_submit, chat.ingested)
    ; loop {
        effect(cap_submit, LLM call)         // settles llm.response
        for each tool_call:
          effect(cap_dispatch, tool intent)  // settles dispatch.* quota/outcome commits
          commit(cap_submit, tool.executed)
      } bounded by spec.budget, gated by admission lease projection
    ; commit(cap_app, spec.deliver.event) via delegated app-fact authority
      OR commit(cap_submit, agent.aborted.*)

// streamEvents : live tail wire (spec-29)
streamEvents(opts)
  = project(events, after = opts.afterId) ++ react(any kind, forward)
    with cursor (id ASC), SSE transport
```

Notes:

- `submitTextStream` is **not a core composite in v0.3**. It moves to
  `@agent-os/streaming`. If that package is not ready, v0.3 ships without a
  public token-streaming API instead of keeping a base-class fallback.
- `dispatchToScope` requires `__agentosReceiveDispatch` on the receiver DO,
  which itself is a `cap_dispatch` settlement — this stays internal RPC.

---

## 5. Standard projections

First-class projections. Each is SSoT-shaped: one fact, one location, no
app-side reconstruction.

```ts
// On AgentDOBase (RPC-callable):

runTrace(runId): Promise<RunTrace>
  // submit lifecycle reconstruction from submit-owned run facts
  // (`chat.ingested`, `llm.response`, `tool.executed`, `agent.*`)
  // plus the delegated deliver event.
  // Returns: { runId, startedAt, turns: LlmTurn[], toolCalls: ToolCall[],
  //            terminal: { kind, at, payload } | null }

runStatus(runId): Promise<RunStatus>
  // RunStatus =
  //   | { kind: "delivered",   at: number, event: string }
  //   | { kind: "aborted",     at: number, abortKind: AbortKind }
  //   | { kind: "open_without_terminal", startedAt: number }
  //   | { kind: "orphaned",    startedAt: number, evidence: string }
  // Honesty: "open" vs "orphaned" requires heartbeat or CF Workflow
  // instance status evidence. Without that evidence, returns
  // open_without_terminal, never "in-flight".

quotaState(spec): Promise<QuotaState>
  // spec = { key, windowMs, limit }
  // QuotaState = { consumed, limit, remaining, refundable, windowStart? }
  // v0.3 refundable is always 0; refunds belong to resource reservations.

resourceState(resourceKey): Promise<ResourceState>
  // ResourceState = { granted, reserved, consumed, available,
  //                   reservations: { id, amount }[] }

admissionLease(attemptKey): Promise<CapabilityLease | null>
  // attemptKey = { route, schemaContract, strategy, adapterVersion }
  // (spec-25 §7 full key — not the truncated (route, sc) form.)

events(opts): Promise<ReadonlyArray<LedgerEventRpc>>
  // Raw cursor query. Existing; retained as the lowest-level projection.
```

Notes:

- All projections are pure functions of committed events. No backing
  tables for derived state (spec-24 §3.1 preserved).
- `simulate(view, deltas)` (hypothetical projection used internally by
  quota pre-grant) is **not exposed**. Internal-only until N+1 evidence
  proves an app needs it.

---

## 6. Standard vocabularies

Three vocabularies retained from prior specs, namespaced by capability:

| Vocabulary             | Owner          | Reference            |
|------------------------|----------------|----------------------|
| Abort kinds            | `cap_submit`   | spec-24 §7           |
| Run lifecycle terms    | `cap_submit`   | spec-24 §5.1.1       |
| Structured evidence    | `cap_admission`| spec-25 §3, §7       |

Submit, dispatch, and resource event kinds are owned by their respective
capabilities but were not formalized as "vocabularies" in v0.2; this spec
promotes them:

| Vocabulary             | Owner          | Kinds                                                              |
|------------------------|----------------|--------------------------------------------------------------------|
| Submit turn facts      | `cap_submit`   | `chat.ingested`, `llm.response`, `tool.executed`, `agent.run.started`, `agent.aborted.*` |
| Dispatch outcomes      | `cap_dispatch` | `dispatch.outbound.requested`, `dispatch.outbound.delivered`, `dispatch.outbound.failed`, `dispatch.inbound.accepted`, `dispatch.consumed`, `dispatch.rate_limited` |
| Resource transitions   | `cap_resource` | `resource.granted`, `resource.reserved`, `resource.reserve_rejected`, `resource.consumed`, `resource.released` |

Unsupported vocabulary:

- `dispatch.tool_error` and `dispatch.upstream_failure` are not v0.3 event
  kinds. Tool and upstream failures remain `agent.aborted.*` facts until a
  dispatch-failure spec assigns a different owner.
- `resource.expired` is not a v0.3 event kind. Reservation TTL/expiry requires
  a resource-expiry spec before it can appear in the vocabulary.
- `quota.*` is not a v0.3 event namespace; quota state is projected from
  `dispatch.consumed`. `dispatch.rate_limited` is an observation, not state.

---

## 7. Extension package capabilities

Extension support has two halves:

1. **namespace claim** — a package declares the event prefixes it owns, so
   app-facing write paths cannot forge those facts;
2. **positive capability** — core mints a scoped handle that lets that package
   commit its own protected facts without reaching into core internals.

The namespace claim is the v0.3 baseline already required by image/sandbox
package extraction. P1 positive `commit/time` is the packageization boundary
for proof/projection carriers. P2 positive `effect` remains future work.

### 7.1 Namespace claim

```ts
interface ExtensionPackage {
  packageId: string                    // "@agent-os/image"
  kindPrefixes: ReadonlyArray<string>  // ["image."]
  version: string                      // package semver
}

// AgentDOBase.registerExtensions()
//   - validates kindPrefixes disjoint from substrate caps and any
//     previously-registered extensions in this DO class
//   - extends the app-facing negative gate:
//     emitEvent / submit.deliver / scheduleEvent / dispatchToScope.event
//     reject matching package prefixes with CapabilityRejected

class AgentDOBase {
  protected registerExtensions(): ReadonlyArray<ExtensionPackage> { return [] }
  // subclass override; validated lazily once per DO instance.
}
```

Consequences:

- **`image.*` reservation in spec-32 §1 is removed from core vocabulary.**
  `@agent-os/image` may register itself with `kindPrefixes: ["image."]` so
  app-facing core write paths cannot forge image package facts. Core knows
  the extension declaration, not image semantics.
- **Same path applies to** audio / video / web / browser / dynamic-worker /
  sandbox / any future modality.
- **Same path applies to** any future streaming package-owned ledger facts
  (for example `stream.*`). Token deltas remain ephemeral unless that package
  writes a dedicated spec that promotes them to ledger facts. Extension
  packages do not get to write `agent.*`; that namespace stays `cap_submit`.
- **No global mutable registry.** Extension registration is per-DO-class,
  declared by `registerExtensions()` override, validated at DO
  construction.
- **The claim is not a write handle.** It only removes the prefix from
  `cap_app`. The package still needs §7.2 before it can commit package-owned
  facts.

v0.3 ships `ExtensionPackage`, disjoint-prefix validation, and the negative
runtime commit gate.

### 7.2 Positive package capability

Core mints an unforgeable scoped handle for a registered package:

```ts
type ExtensionEventSpec = {
  event: string
  data: unknown
}

type ExtensionEffectOutcome<R> =
  | { ok: true; result: R }
  | { ok: false; cause: unknown }

interface ExtensionCapability {
  readonly packageId: string
  readonly kindPrefixes: ReadonlyArray<string>
  readonly version: string

  commit(spec: ExtensionEventSpec): Promise<{ id: number }>

  time(spec: ExtensionEventSpec & { at: number }): Promise<{ id: number }>

  // P2, not P1:
  effect<I, R>(spec: {
    idempotencyKey: string
    intent: I
    run: (intent: I, signal: AbortSignal) => Promise<R>
    settle: (outcome: ExtensionEffectOutcome<R>) => ExtensionEventSpec
  }): Promise<{ eventId: number; outcome: ExtensionEffectOutcome<R> }>
}

class AgentDOBase {
  protected extensionCapability(packageId: string): ExtensionCapability
}
```

Rules:

- **P-1.** The handle can be minted only for a package returned by
  `registerExtensions()` in the current DO class. Missing package id =
  unavailable capability, not fallback to `cap_app`.
- **P-2.** `commit` and `time` accept only event kinds covered by that
  package's registered prefixes. Package A cannot write package B, core, or
  app facts.
- **P-3.** The handle is scope-bound to the current DO instance. It is not an
  RPC argument, not serializable, and not a bearer token that can be moved
  across scopes.
- **P-4.** `time` is `cap_scheduler(cap_ext)`; the pending row stores a
  package-owned event kind, and the only public creation path for that prefix
  is the scoped package capability. Alarm promotion commits the same
  package-owned event, not an app fact.
- **P-5.** `effect` is the positive form of the kernel effect op:
  external side-effect plus exactly-one ledger settlement by idempotency key.
  `settle` must return one package-owned event. Large logs, files, build
  outputs, deploy manifests, and rollback material remain carrier refs.
- **P-6.** Positive extension authority does not include delegated app-fact
  authority. If a package result should also advance an app saga, the host app
  commits that app fact separately under `cap_app`.
- **P-7.** Extension packages never receive `cap_submit`, `cap_dispatch`,
  `cap_resource`, or `cap_admission`. They may call public composites/tools,
  but cannot write those vocabularies directly.

This is the missing piece for reusable package-owned vocabularies such as
`git.*`, `verification.*`, `deploy.*`, and `staging.*`. Without it, those
packages must either avoid package-owned events or improperly reach into core.

### 7.3 Implementation stages

The implementation can land without forcing zeroY-style app pressure to wait
for package extraction:

| Stage | Ships | Does not claim |
|-------|-------|----------------|
| P0 — v0.3 baseline | `ExtensionPackage` declaration + negative app gate | package-owned writes |
| P1 — positive commit/time | `ExtensionCapability.commit`, `ExtensionCapability.time`, prefix owner validation, package-only tests | core-owned external-effect outbox semantics |
| P2 — positive effect | `ExtensionCapability.effect` with idempotent side-effect settlement | generic rollback engine or carrier byte store |

P1 is enough for a package to record proof facts after a carrier operation whose
idempotency is already handled by the carrier/provider. P2 is required when
agentOS itself claims the idempotency boundary for package-owned live effects.

### 7.4 Pressure rule

Positive capability blocks **package-owned protected vocabularies**, not
app-scoped MVP composition.

Before extracting reusable carrier packages, pressure apps should use ordinary
tools plus app-owned facts:

```text
carrier tool -> tool.executed.result(proof refs)
host app     -> change.gate.recorded / change.ready_for_review
host app     -> change.approval.decided
host app     -> change.publish.started / change.publish.step_recorded
host app     -> change.published | change.publish_failed
```

Only facts that remain stable across pressure apps graduate into package-owned
vocabularies. This prevents zeroY-specific nouns from being frozen as
`git.*`, `verification.*`, `deploy.*`, or `staging.*` too early.

---

## 8. Public surface (final)

### 8.1 `AgentDOBase` method set

This is the P0/v0.3 baseline surface plus P1
`protected extensionCapability(packageId)` from §7.2; it is not RPC-callable
and must not appear in app-facing composites.

```ts
class AgentDOBase<Env> {
  // ----- composites (RPC) -----
  submit(spec: SubmitSpec): Promise<SubmitResult>
  emitEvent(spec: { event: string; data: unknown }): Promise<{ id: number }>
  scheduleEvent(spec: ScheduledEventSpec): Promise<{ id: number }>
  dispatchToScope(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult>
  streamEvents(opts?: StreamEventsOptions): Response

  // ----- projections (RPC) -----
  events(opts?: EventQueryOptions): Promise<ReadonlyArray<LedgerEventRpc>>
  runTrace(runId: string): Promise<RunTrace>
  runStatus(runId: string): Promise<RunStatus>
  quotaState(spec: QuotaStateSpec): Promise<QuotaState>
  resourceState(key: string): Promise<ResourceState>
  admissionLease(key: AttemptKey): Promise<CapabilityLease | null>

  // ----- resource composites (RPC) -----
  grantResource(spec: ResourceGrantSpec): Promise<ResourceGrantResult>
  reserveResource(spec: ResourceReserveSpec): Promise<ResourceReserveResult>
  consumeResource(spec: ResourceReservationSpec): Promise<void>
  releaseResource(spec: ResourceReservationSpec): Promise<void>

  // ----- CF runtime hook -----
  alarm(): Promise<void>

  // ----- subclass extension surface (protected) -----
  protected on(kind: string, handler: EventHandler): void
  protected off(kind: string, handler: EventHandler): void
  protected provideDispatchTargets(): DispatchTargetRegistry
  protected provideRefResolver(): RefResolver
  protected registerExtensions(): ReadonlyArray<ExtensionPackage>
  // P1 positive package surface:
  protected extensionCapability(packageId: string): ExtensionCapability
  // provideRegistry() removed — replaced by provideRefResolver().
}
```

Removed from `AgentDOBase`:

- `generateImage(spec)` — moves to `@agent-os/image`.
- `submitTextStream(spec)` — moves to `@agent-os/streaming`; if that package is
  not ready, v0.3 has no public token-streaming API.
- `provideRegistry()` — replaced by `provideRefResolver()` (see §10.3).
- `__agentosReceiveDispatch` — stays internal (it always was; the underscore
  marks it as private RPC, not public surface).

### 8.2 Barrel exports (`@agent-os/core` v0.3)

```ts
// AgentDOBase + env
export { AgentDOBase, type AgentDOEnv }

// Composite spec types
export type {
  SubmitSpec, SubmitResult, TurnRef,
  ScheduledEventSpec,
  DispatchToScopeSpec, DispatchToScopeResult,
  EventQueryOptions, StreamEventsOptions,
}

// Projection result types
export type {
  RunTrace, RunStatus,
  QuotaStateSpec, QuotaState,
  ResourceState,
  LedgerEventRpc, EventHandler, TraceContext,
}

// Resource composite types
export type {
  ResourceGrantSpec, ResourceReserveSpec, ResourceReservationSpec,
  ResourceGrantResult, ResourceReserveResult,
}

// Tools + quota middleware
export type { Tool, ToolDefinition, LlmUsage }
export { withQuota, type QuotaSpec }

// Dispatch target registry (for provideDispatchTargets())
export type { DispatchTargetNamespace, DispatchTargetRegistry }

// Abort taxonomy
export { ABORT, type AbortKind }

// Tagged errors
export {
  SqlError, JsonStringifyError,
  ScopeMissingError, InvalidScheduleAt,
  DispatchTargetNotFound, DispatchScopeMismatch,
  InvalidResourceAmount, ResourceInsufficient,
  ResourceReservationNotFound, ResourceReservationClosed,
  UpstreamFailure, ToolError,
  RefResolutionFailed,
  CapabilityRejected,
}

// Admission public surface (narrow)
export type { JsonSchemaObject, JsonSchemaNode }     // for submit({outputSchema})
export type { LlmRoute }                              // for SubmitSpec
export type { CapabilityLease, AttemptKey }           // for admissionLease() return
//   Strategy / Outcome / OutcomeClass / SchemaContract / AdmissionImpact
//   are submit-internal — NOT exported at barrel.

// Ref resolution and extension package claims
export type { RefResolver, ExtensionPackage, ExtensionCapability }
```

Carrier packages that need only these contracts import narrow subpaths instead
of the `@agent-os/core` barrel, so modality packages do not pull the
Cloudflare Durable Object type surface:

```ts
import type { ExtensionCapability, ExtensionPackage } from "@agent-os/core/extensions"
import { RefResolutionFailed, type RefResolver } from "@agent-os/core/ref-resolver"
```

Removed from barrel:

- `ImageRoute / ImageArtifact / ImageResult / GenerateImageSpec / ImageRequest`
  — re-exported from `@agent-os/image` instead of core.
- `ProviderRegistryConfig / EndpointNotFound / CredentialNotFound` — replaced
  by `RefResolver` and `RefResolutionFailed`.
- `SubmitTextStreamSpec / SubmitTextStreamFrame` — see §10.
- `Strategy / Outcome / OutcomeClass / SchemaContract / AdmissionImpact` —
  submit-internal.
- `DispatchEnvelope` — receiver RPC envelope is internal, not a tool-author
  surface.

---

## 9. Honesty revisions

### 9.1 Replay

spec-24 §4 corollary currently reads:

> Corollary: `agent.run` is a pure function of the ledger snapshot.
> Replayable + sandboxable + auditable for free.

Revised:

> Corollary: `agent.run` is **trace-projectable and auditable** from the
> ledger snapshot via `runTrace(runId)`. Deterministic replay (i.e.
> re-executing a run and obtaining bit-identical outputs) is **not a v1
> guarantee**. CF Workflow `step.do` capture is the candidate substrate for
> deterministic replay; a spike must validate whether `step.do` I/O is
> reproducible across DO/Workflow restarts before any `replay(runId)`
> primitive is added.

### 9.2 Quota / Resource — INV-3 split

spec-24 INV-3 currently reads:

> Pre-grant + consume patterns unify into **Quota**.

Revised:

> Pre-grant + consume patterns share a **linear accounting algebra** but
> split into two ergonomics:
>
> - **Quota** — immediate-consume. Pre-check + atomic consume in one
>   dispatch step. Refund-on-failure is supported but the reservation is
>   never observable as a distinct state.
> - **Resource** — delayed-finalize. Explicit `reserve → consume | release`
>   lifecycle with the reservation as a first-class object (TTL, partial
>   consume, partial release).
>
> Both are owned by core under their respective capabilities
> (`cap_dispatch` for quota's consume events, `cap_resource` for the
> reservation lifecycle). Apps choose by need: rate-limit / token-budget /
> simple billing → Quota; multi-stage settlement / refundable holds → Resource.

This makes spec-32 §1's reference to "unify into Quota" obsolete; both
remain core-owned but separately surfaced.

### 9.3 Reserved-prefix language

spec-32 §1 currently establishes `image.` as a core-reserved event prefix
on the grounds that "image job vocabulary is substrate-owned". v0.3
replaces this with:

> Image job vocabulary is **package-owned** via §7's extension package
> claim. Core does not reserve modality-named namespaces. The
> `@agent-os/image` package may register `image.` as its kindPrefix so
> app-facing core write paths reject `image.*`; package-owned writes use the
> staged positive capability in §7.2 / §7.3 when that implementation phase is
> enabled.

---

## 10. Removed surface

Concrete delta against core v0.2.17. All removals are breaking.

### 10.1 Moved out of core

| Item                              | Destination                       | Mechanism                              |
|-----------------------------------|-----------------------------------|----------------------------------------|
| `AgentDOBase.generateImage`       | `@agent-os/image`                 | carrier exposed via tools or direct call |
| `ImageRoute / ImageArtifact / ImageResult / GenerateImageSpec / ImageRequest` types in barrel | `@agent-os/image` barrel | re-export from package, not core |
| `image.*` core reserved prefix (spec-32 §1) | extension package claim (§7) | `@agent-os/image` may register `image.` so app-facing core writes cannot forge image facts; package-owned writes use staged positive capability |
| `submitTextStream` method + `SubmitTextStreamSpec` / `SubmitTextStreamFrame` types | `@agent-os/streaming` (new) | moved out; if package is absent, v0.3 has no public token streaming |
| `ProviderRegistryConfig` + `EndpointNotFound` / `CredentialNotFound` errors | generalized `RefResolver` | see §10.3 |

### 10.2 Narrowed / hidden

| Item                                            | New location                                 |
|-------------------------------------------------|----------------------------------------------|
| `Strategy / Outcome / OutcomeClass / SchemaContract / AdmissionImpact` types | submit-internal; not in barrel |
| `provideRegistry()` protected hook              | replaced by `RefResolver` mechanism (§10.3) |

### 10.3 RefResolver

v0.3 chooses the general mechanism. `ProviderRegistry` is deleted as an
LLM-only special case and replaced by a capability-neutral resolver:

```ts
interface RefResolver {
  endpoint(ref: string): string | null
  credential(ref: string): string | null
}
```

Any core composite or extension carrier that needs
`(endpointRef, credentialRef) -> (endpoint, credential)` uses the same
resolver. Missing refs fail fast with `RefResolutionFailed`; there is no
submit-specific fallback registry. Secret values still never enter the ledger.

---

## 11. Spec amendments / supersessions

| Spec     | Section(s)         | Action                                                                 |
|----------|--------------------|------------------------------------------------------------------------|
| spec-24  | §3 SSoT discipline | **Amend**: prepend "commit authority + capability owners (see spec-34 §3)" as the primary frame; existing table preserved as a runtime consequence. |
| spec-24  | §4 corollary        | **Amend**: replace "replayable" wording per spec-34 §9.1.              |
| spec-24  | §5.1 four algebra ops | **Supersede**: replaced by spec-34 §2 five-op kernel. `ingest` / `dispatch` documented as internal causation patterns of `commit`. |
| spec-24  | §5.1 reactive face   | **Amend**: reframe `emitEvent` / `scheduleEvent` / `on` as composites under capability ownership (spec-34 §4). |
| spec-24  | §6 carrier middleware | **Amend**: add cross-reference to spec-34 §5 standard projections.   |
| spec-24  | INV-3                 | **Amend**: split per spec-34 §9.2.                                    |
| spec-24  | §7 failure events     | **Amend**: add capability owner column (spec-34 §6).                  |
| spec-25  | §7 admission key     | **Preserve**: `attemptKey = (route, schemaContract, strategy, adapterVersion)` is the canonical projection key (spec-34 §5).  |
| spec-31  | text streaming       | **Supersede**: `submitTextStream` leaves `AgentDOBase`; future public surface belongs to `@agent-os/streaming`, with package-owned writes gated by §7.2. |
| spec-32  | §1 reserved prefix   | **Supersede**: extension package claims (spec-34 §7) replace modality-named reservation. |
| spec-32  | §2 package direction | **Supersede**: `AgentDOBase.generateImage` leaves core. `@agent-os/image` owns public image API; package commit authority follows §7.2 / §7.3. |

---

## 12. Open questions

1. **[Open] What is the first package that requires P2
   `ExtensionCapability.effect`?** P1 commit/time is enough for package proof
   facts after carrier-owned idempotent operations. P2 should wait until a
   package needs agentOS-owned idempotent side-effect settlement rather than a
   provider/carrier idempotency key.

2. **[Open] Deterministic replay primitive.** §9.1 demoted the claim. The
   open question is whether CF Workflow `step.do` capture is sufficient
   for bit-identical replay across restarts. Resolution requires a spike;
   resolution determines whether `replay(runId)` is ever a v2 primitive.

3. **[Open] `simulate(view, deltas)`.** Used internally by quota pre-grant.
   Could become public if admission / resource also need it. Not exposed
   until N≥2 internal users prove the case.

4. **[Open] cross-scope `react`.** v1 same-scope-only. Promoting to
   cross-scope requires a queue-mediated transport; out of scope for v0.3.

---

## 13. Validation

This spec is a refactor target, not a code change. Validation is the
implementation PR, which must show:

- All barrel exports listed in §8.2 exist; all items in §10.1 / §10.2 are
  gone from the barrel.
- `runTrace / runStatus / quotaState / resourceState / admissionLease`
  methods exist on `AgentDOBase` and return §5's types.
- `CapabilityRejected` error is reachable via every write path that
  previously raised `ReservedEventKindError`; `ReservedEventKindError` is
  removed from the barrel.
- P0 validation: `ExtensionPackage` type exists and runtime registration
  rejects overlapping prefixes. Registered extension facts are not writable by
  app-facing `emitEvent`, `submit.deliver.event`, `scheduleEvent`, or
  `dispatchToScope.event`.
- P1 validation: `ExtensionCapability.commit/time` can be minted only for a
  registered package id; it can write only that package's prefixes; app code
  still cannot forge those prefixes.
- P2 validation: `ExtensionCapability.effect` settles exactly one
  package-owned event per idempotency key and does not store carrier bytes in
  the ledger.
- `AgentDOBase.generateImage` and `AgentDOBase.submitTextStream` are absent.
  Their types are absent from `@agent-os/core` barrel.
- `ProviderRegistryConfig`, `EndpointNotFound`, and `CredentialNotFound` are
  absent; `RefResolver` and `RefResolutionFailed` are the only ref-resolution
  surface.
- spec-24 / spec-25 / spec-31 / spec-32 amendments per §11 land in the
  same PR series.
- Insight Helper / WhatsApp / Img-Gen / zeroY reference apps in spec-24
  §16 compile and pass contract tests under the new surface (or skeletons
  updated when the surface mandates it).

Retained composites should keep their ledger behavior. The public surface is
intentionally breaking: modality and token-streaming APIs leave `AgentDOBase`,
capability failures use `CapabilityRejected`, and ref resolution is generalized.

---

## Appendix A: Naming rationale

- **`commit` over `log` / `append`**: emphasizes the authority gate.
  "log" reads as observability; "append" reads as anyone-can-write.
- **`effect` over `dispatch`**: `dispatch` survives at the composite layer
  (`dispatchToScope`) and as a vocabulary owner (`cap_dispatch`). The
  kernel op name is upgraded because "dispatch" conflated `effect with
  idempotent settlement` with `cross-scope routing`.
- **`time` over `schedule`**: `scheduleEvent` survives at the composite
  layer. The kernel op is named for the axis it embodies (deferred-commit
  time-machine), not the user-facing verb.
- **`react` over `on`**: `on` / `off` survive as the subclass extension
  surface. The kernel read-forward op is named for what it is (a reactive
  read), not for the imperative call shape.

These naming choices keep the user-visible composites stable (apps still
call `emitEvent / scheduleEvent / on / submit`) while clarifying the
kernel-level vocabulary.

---

## Appendix B: Diff against spec-24 §5.1 (visual)

```
spec-24 §5.1 (v0.2):

   ingest(channel, payload)   → log(event)
   dispatch(carrier, intent)  → effect + log(event)
   log(event, scope, tier?)   → ledger
   project(view, source?)     → readonly

   + reactive face: emitEvent / scheduleEvent / on
   + view.reflective.{agentRuns, currentBudget, currentQuotaState}

spec-34 §2 (v0.3):

   commit(cap, event)                  authorized write, no side-effect
   effect(cap, intent) -> result       external side-effect + idempotent commit
   time(cap, event, at)                deferred commit
   project(view, source?)              bounded read of past
   react(kind, handler)                forward read of future commits

   composites (§4):     emitEvent / scheduleEvent / dispatchToScope / submit / streamEvents
   projections (§5):    runTrace / runStatus / quotaState / resourceState / admissionLease / events
   capabilities (§3):   cap_dispatch / cap_resource / cap_submit / cap_admission / cap_app / cap_scheduler
   extensions (§7):     ExtensionPackage declarations + negative gate + staged positive cap
```
