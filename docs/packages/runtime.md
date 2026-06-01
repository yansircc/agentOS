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

`TriggerTx` exposes tx-local ledger reads through `events()`. Triggers that need
current business state fold those rows inside commit before appending terminal
facts or enqueueing more intents; they do not import backend storage internals.

`commit` is a synchronous transaction callback. It must not `await`, return a
Promise/thenable, or enqueue fire-and-forget callbacks through `.then`, timers,
or microtasks. All ledger and projection writes must finish before `commit`
returns. `AcquireCtx` intentionally has no `attempt` field in 0.2.x; retry
semantics are derived from ledger/domain state folds until a concrete adapter
requires a stronger identity surface.

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
