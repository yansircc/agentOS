# @agent-os/runtime

## Purpose

Backend-neutral runtime programs and Effect Tag contracts: submit/run API types,
boundary commit enforcement, dispatch/scheduler/resource/quota/admission
algebra, durable trigger authoring, and ledger-derived projections.

## Invariant

Runtime code expresses programs against Effect Tags. It does not import Worker
modules, Durable Object state, SQL storage implementations, or platform alarm
APIs.

Durable trigger authors depend on runtime for the shared trigger algebra:
`DurableTrigger`, `AcquireCtx`, `TriggerTx`, trigger parse helpers,
`DurableTriggerRegistry`, `makeDurableTriggerRegistry`, `getDurableTrigger`,
`scheduledEventTrigger`, and `DispatchTargetAdapter`. Runtime owns the
backend-neutral shape; concrete backends own storage, alarm re-arm, SQL
transactions, and pump execution.

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
`attempt` field in 0.2.x; retry semantics are derived from ledger/domain state
folds until a concrete adapter requires a stronger identity surface.

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

## Minimal Usage

Depend on runtime for consumer-facing run, admission, and backend-neutral Tag
types. App triggers should be written against runtime trigger interfaces and
registered through a backend facade; they should not import backend SQL helpers,
due-work storage helpers, inserted-event helpers, or backend state classes.

```ts
import type { DurableTrigger, Ledger, SubmitSpec } from "@agent-os/runtime";
```

## Verification

```sh
cd packages/runtime
bun run test
```
