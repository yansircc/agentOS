# @agent-os/runtime

## Purpose

Backend-neutral runtime programs and Effect Tag contracts: submit/run API types,
boundary commit enforcement, dispatch/scheduler/resource/quota/admission
algebra, durable trigger authoring, and ledger-derived projections.

## Invariant

Runtime code expresses programs against Effect Tags. It does not import Worker
modules, Durable Object state, SQL storage implementations, or platform alarm
APIs.

The `./testing` subpath executes the core-owned backend conformance manifest against
an adapter-provided driver. The public programmatic runner has no Vitest dependency,
creates and disposes one driver per law, and returns a core-validated report. Repo
test runners register those same law bodies through an injected registrar.

`LedgerArchive` performs verified physical relocation only. A receipt is emitted
after archive write and exact readback; eviction revalidates the stored receipt and
archive bytes before deleting the exact hot event ids. Ordinary ledger reads and
projection rebuilds merge verified archive segments with hot rows before filtering
or pagination. Archive metadata is not a replay checkpoint or product reset fact.

Effect AI provider peers are subpath-local by contract. The
`llm-effect-ai/openai-compatible` subpath imports no Anthropic provider package
and is covered by packed consumer proof without `@effect/ai-anthropic`
installed. `@effect/ai-anthropic` remains package-level optional peer metadata
only because npm cannot scope peers to individual exports; split providers into
separate packages if package-level optional peers start forcing installs or the
OpenAI-compatible import graph reaches Anthropic code.

Materialized projections are the backend-neutral current-state counterpart to
the ledger. Apps declare `defineProjection({ kind, version, eventKinds,
identity, state, identityKey, identify, initial, reduce })`; backends own table
storage, transaction coupling, status, and rebuild. Reducers are synchronous.
Projection rows store refs and metadata only; bytes, zip bodies, raw secrets,
provider URLs, tokens, and account ids remain outside ledger-visible state.
Version mismatch reports `needs_rebuild`; backends do not silently repair rows.

Durable trigger authors depend on runtime for the shared trigger algebra:
`DurableTrigger`, `AcquireCtx`, `TriggerTx`, trigger parse helpers,
`DurableTriggerRegistry`, `makeDurableTriggerRegistry`, `getDurableTrigger`,
and `scheduledEventTrigger`. Runtime owns the
backend-neutral shape; concrete backends own storage, alarm re-arm, SQL
transactions, and pump execution.

Schedule authoring is a product-level time ingress over sessions and workflows,
not a runtime scheduler helper. Authored `defineSchedule` declarations use
five-field UTC cron expressions. Generated targets map provider scheduled
metadata to the compiled schedule registry and call the shared schedule delivery
dispatcher. Runtime ingress delivery events record provider-neutral delivery
attempts, receipts, retry state, and replay projection; schedule fire events
record the requested, dispatched, or failed product handoff. Schedule history
projections join those facts to linked session/workflow/run projections for
downstream status. Apps own provider lifecycle, callback parsing, and external
side effects reached through the submitted product ingress.

Durable trigger acquire effects that touch external providers must be
provider-idempotent. The trigger pump guarantees at-most-one terminal ledger
commit for a due row, not exactly-once external side effects across backend
eviction, redrive, or provider retry. `AcquireCtx` provides stable trigger
identity (`scope`, `dueWorkId`, `intentEventId`) plus cooperative cancellation
(`signal`) and binary redrive context (`acquireMode: "normal" | "redrive"`).
It intentionally has no ledger read access in acquire.

Every trigger declaration explicitly chooses
`cancellation: "cooperative" | "ignored"`. Cooperative triggers can be marked
cancelled by `cancelTrigger`; ignored triggers reject cancellation at the
trigger-pump boundary without reading or mutating due-work. There is no default.
Registry construction fails closed when a trigger omits `cancellation` or
`commitCancelled`.

`TriggerTx` exposes tx-local ledger reads through `events()`. Triggers that need
current business state fold those rows inside commit before appending terminal
facts or enqueueing more intents; they do not import backend storage internals.

`commit` and `commitCancelled` are synchronous transaction callbacks. They must
not `await`, return a Promise/thenable, or enqueue fire-and-forget callbacks
through `.then`, timers, or microtasks. All ledger and projection writes must
finish before the callback returns. `AcquireCtx` intentionally has no numeric
`attempt` field; retry semantics are derived from ledger/domain state folds
until a concrete adapter requires a stronger identity surface.

Cancellation is cooperative. A trigger may fail acquire with
`DurableTriggerAcquireCancelled`; the backend then runs the trigger-owned
`commitCancelled` transaction callback. If an adapter ignores `signal` and
returns a normal outcome before a cancelled/redriven row reaches a terminal
cancellation commit, normal commit can still win. Claim-token rechecks prevent
duplicate terminal facts.

Trigger portability is explicit:

- Pure triggers depend only on runtime trigger algebra and are portable across
  concrete backends.
- Backend-bound triggers close over backend construction context and only
  promise that backend's transaction semantics.

Fact payloads are append-only compatible. A breaking semantic change uses a new
event kind; readers and app-owned projections merge old and new kinds instead
of rewriting ledger history.

Attached streams are the live I/O counterpart to durable triggers. Runtime owns
the backend-neutral `AttachedStreamHandler`, registry, cancel/detach contract,
and shared runner. Intermediate frames are not ledger facts; `commitTerminal`
is the only stream-owned settlement hook and is always explicit. `onDetach`
must be declared as `"abort"` or `"continue"` so the substrate never silently
chooses between cost-saving abort and background completion.

Submit LLM calls have two independent time axes. `budget.timeMs` bounds the
whole run lifecycle. `budget.llmCallTimeoutMs` bounds each individual provider
call and defaults to `DEFAULT_LLM_CALL_TIMEOUT_MS`. Runtime uses the smaller of
the remaining run time and the call timeout: remaining run exhaustion settles as
`agent.aborted.budget_time`, while call timeout settles as
`agent.aborted.upstream_failure` with cause `provider_timeout`. Submit is
currently non-streaming, so the boundary is a total provider-call timeout, not
an idle stream timeout; future streaming LLM transport should use idle timeout
semantics instead.

Workspace-job consumer observability is a runtime composition projection, not a
carrier fact. `projectWorkspaceJobObservability(events, jobRunId)` joins the
raw workspace-job terminal projection with runtime failure diagnostics through
the internally recorded submit run correlation. The returned projection is
sanitized: failed state exposes request summary and `failureExplanation`, but
never exposes the runtime numeric run id or raw `submitRunId` join key.

Cloudflare workspace identity has two independent axes. The authenticated
ledger routing scope owns the persistent Sandbox id and workspace ref; a
runtime-owned run id owns only the transient lease/session lifecycle. The
public `./cloudflare` workspace resolvers enforce that split for hosts and
generated targets. Cleanup releases a run lease without destroying the shared
scope workspace. Generated `submit_scope` targets use the named Durable Object
routing identity at submit, provider-operation, read, reset, and destroy
entrypoints; submit/browser/model input cannot select workspace state.

Runtime diagnostic facts are active only when a production runtime path can
prove them from a positive contract. `handler_failed` is emitted by resolved
capability handler wrappers. `projection_timeout` is emitted by tool projection
waits with operation, authority, and requested-event provenance. `preflight_failed`
uses schema-owned string detail. `handler_missing` remains reserved vocabulary
until capability requirements declare required handler contracts and runtime
code emits it from that contract.

Dynamic capability phase policy is generic runtime algebra over the existing
dynamic capability projection. Products may pass opaque submit-time
`dynamicCapability.phase` values such as observe/propose/change/publish-style
labels into generated targets, but those labels remain product facts and are not
runtime enums, ledger events, or workflow state. Generated targets pass the
opaque input to dynamic resolvers; resolvers can call
`lowerDynamicCapabilityPhasePolicy` with access categories such as `read`,
`write`, `durable_request`, and `external_effect`. The lowerer emits slot-local
allow/deny selections and structured `capability_phase_policy_denied`
diagnostics; model-visible tools, skills, and instruction fragments still come
only from the dynamic capability projection.

## Minimal Usage

Depend on runtime for consumer-facing runtime execution, admission service, and
backend-neutral Tag types. App triggers should be written against runtime trigger interfaces and
registered through a backend facade; they should not import backend SQL helpers,
due-work storage helpers, inserted-event helpers, or backend state classes.

```ts
import type { DurableTrigger, Ledger } from "@agent-os/runtime";
```

Serializable submit, admission, and runtime event DTOs live in
`@agent-os/runtime-protocol`, not runtime.

Attached stream handlers use the same runtime package:

```ts
import type { AttachedStreamHandler } from "@agent-os/runtime";
```

Materialized projections are registered through the backend facade:

```ts
import { defineProjection, type MaterializedProjections } from "@agent-os/runtime";
```

Workspace-job consumers that need user-visible failure explanation should read
the runtime observability projection instead of calling
`projectFailureDiagnostics(events, runId)` themselves:

```ts
import { projectWorkspaceJobObservability } from "@agent-os/runtime";
```

Deterministic product-side tool actions use `unsafeRunToolByName`. The `unsafe`
prefix is intentional: it bypasses submit, admission, quota, retries, and ledger
settlement. Do not use it for LLM-selected tools; those must go through
`submit`.

Quota grants are keyed by the semantic tool claim operationRef. Retrying the
same tool claim cannot double-charge quota; separate tool calls still consume
separate quota.

## Verification

```sh
pnpm --filter @agent-os/runtime test
```
