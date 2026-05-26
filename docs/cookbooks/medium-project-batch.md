# Medium Project Batch

This batch is a second parallel-agent pressure run. Each project composes two or
more public surfaces. The output is a report, not a tracked app.

Run each project in its own worktree via
`scripts/parallel-dev/create-agent.sh`.

## Shared Rules

- Implementation path: `spikes/_active/<agent-id>-<case>/`
- All scopes, fixture keys, resource keys, artifact keys, and queue names start
  with `$SCOPE_PREFIX`
- Servers bind only to `$PORT_BASE` through `$((PORT_BASE + 9))`
- Use stubs by default; live provider calls require explicit assignment
- Do not modify `packages/core` unless the task is escalated from pressure test
  to substrate fix
- Report with the format in root `AGENTS.md`
- Use `scripts/parallel-dev/run-spike-vitest.sh` for ignored spike tests

## M1 — Plan, Approval, Timeout

**Surface**: `submit({ outputSchema, tools: {} })`, `emitEvent`,
`scheduleEvent`, `events`.

Flow:

```text
POST /request
  -> submit({ outputSchema: PlanSchema, tools: {} })
  -> approval.requested
  -> scheduleEvent("approval.timeout", at = now + short delay)
POST /approve OR due timeout
  -> approval.decided OR approval.timeout
winner = first ledger id for same approvalId
winner accepted
  -> submit({ intent: execute approved plan })
  -> task.executed
```

Acceptance:

- plan event conforms to schema
- decision-before-timeout and timeout-before-decision both choose by ledger id
- no app-owned approval status table
- second execution path is not hidden inside the structured-output submit

Pressure point: composition of structured output with human approval race.

## M2 — Cross-Scope Fanout/Fanin

**Surface**: `dispatchToScope`, `emitEvent`, `on`, `events`.

Flow:

```text
session -> worker A/B/C: work.requested
worker -> session: work.done
session projects all expected workerIds done
session emits batch.done
```

Acceptance:

- each sender and receiver ledger has dispatch bookkeeping
- parent completion is derived from ledger rows, not a counter table
- duplicate worker completion is idempotent by request key

Pressure point: projection ergonomics without a cross-scope index.

## M3 — Resource Reserve, Failure, Release

**Surface**: `grantResource`, `reserveResource`, `releaseResource`,
`consumeResource`, `dispatchToScope`.

Flow:

```text
session -> user: resource.reserve.requested
user reserves credit
session simulates provider failure
session -> user: resource.release.requested
user releases reservation
retry path reserves again and consumes on success
```

Acceptance:

- available resource returns to the original value after failure release
- duplicate release is idempotent
- later success consumes exactly one reservation
- reservation ids remain opaque refs owned by the reserving DO scope

Pressure point: compensation path for resources, not just happy consume.

## M4 — Structured Plan Then Tool Phase

**Surface**: `submit({ outputSchema, tools: {} })`, normal `submit` with tools,
abort semantics.

Flow:

```text
POST /compose
  -> submit({ outputSchema: ToolPlanSchema, tools: {} })
  -> plan.ready
  -> submit({ intent: plan, tools: { ... } })
  -> tool.executed
  -> composition.done
```

Acceptance:

- direct `outputSchema` plus non-empty tools path is demonstrated as rejected
- two-phase workaround completes with a tool execution
- plan JSON is the only bridge between phases; no shadow tool-plan table

Pressure point: API clarity around the v0 structured-output/tools exclusion.

## M5 — Event Stream Reconnect

**Surface**: `streamEvents({ afterId, kinds })`, `events({ afterId, kinds })`,
Worker fetch integration.

Flow:

```text
client connects stream
server emits events 1..N
client disconnects after id K
client reconnects with Last-Event-ID = K
server snapshots afterId K, drains, then streams live
```

Acceptance:

- no duplicate or missing ids across reconnect
- `Last-Event-ID` is parsed only in Worker/app code, then passed as `afterId`
- filtered stream does not deliver other kinds
- stream sink is unaffected by app `on()` handler failure

Pressure point: spec-29 race-free handoff and app/core HTTP boundary.

## M6 — Image Job With Credit Reservation

**Surface**: `dispatchToScope`, Resources, `generateImage`, artifact refs,
`events`.

Flow:

```text
session -> user: credit.reserve.requested
user reserves image credit
session emits image.job.requested
consumer generates image through stub ImageRoute
consumer stores artifact ref, not bytes
session -> user: credit.consume.requested
session emits image.job.completed
```

Acceptance:

- no image bytes are stored in ledger
- failed image path releases the reservation
- success path consumes exactly one credit
- artifact location is carrier-owned app data, not core state

Pressure point: composition of C3 resources with C5 image route and carrier
boundary.
