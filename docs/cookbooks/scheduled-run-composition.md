# Scheduled Run Composition

> **Pattern**: a Workflow, alarm, or queue schedules/resumes work, while the
> agentOS ledger remains the run truth.
> **Pressure evidence**: vibe-class long-running runs where provider work can
> outlive one HTTP request.
> **Uses**: `submit`, `submitRunStream`, `events`, optional `scheduleEvent`,
> optional derived D1 index.
> **Does NOT introduce**: cross-DO global truth, workflow-owned run status,
> long-running claim phase, or a second run ledger.

## Invariant

The scheduler owns time. The ledger owns facts. Indexes own query speed only.

```text
scheduler intent -> submit / continuation -> agentOS ledger facts
                                |
                                v
                         derived D1/search index
```

Workflow step state, DO alarm state, queue delivery metadata, and D1 rows are
not run truth. They may replay or disappear without changing the canonical
answer to "what happened?" for a run. The answer is projected from ledger
events.

## Failure

Long-running products often drift into two ledgers:

```text
Workflow/D1 says run=publishing
agentOS ledger says no publish claim exists
```

That split makes retries ambiguous. The scheduler cannot know whether to resume,
repair, or skip without consulting app-specific shadow state.

## Minimal Fix

Represent scheduling as intent and run state as projection:

1. Commit or receive a scheduler intent with an idempotency key.
2. Before mutating, read the agentOS ledger from the last known cursor.
3. Project whether the intended continuation is still allowed.
4. Run `submit`, a carrier effect, or an app continuation.
5. Let that operation write normal ledger facts.
6. Update D1/search indexes only from committed ledger rows.

The scheduler may store:

```ts
type SchedulerIntent = {
  idempotencyKey: string;
  scopeRef: string;
  cursor: number;
  wakeAt: number;
  continuation: string;
};
```

The scheduler must not store:

```ts
type ShadowRunTruth = {
  runStatus: "running" | "failed" | "published";
  currentStep: string;
  terminalReason?: string;
};
```

Those fields are projections over ledger events.

## Resume

Resume is cursor + intent, not duplicated state:

```text
load scheduler intent
read events({ afterId: intent.cursor })
project run / saga / claim state
if terminal -> mark scheduler intent consumed
if continuation still valid -> execute next effect
if invalid -> commit or surface app-owned rejection fact
```

The cursor is an optimization boundary. If it is missing or stale, replay from
`afterId=0` and rebuild the projection. Correctness must not depend on a D1
row being current.

## Index

D1 mirrors are allowed when product queries need cross-run or cross-DO scans:

```text
ledger row committed -> projector reads row -> D1 upsert
```

Rules:

- D1 rows carry source ledger refs (`scope`, `eventId`, `kind`).
- D1 rows are rebuildable from ledger snapshots.
- UI may read D1 for speed, but destructive decisions re-read the ledger.
- A D1 write failure is index lag, not run failure.

## Workflow Boundary

Cloudflare Workflow, alarms, queues, or cron triggers own scheduling mechanics:

```text
sleep / retry / backoff / fan-out / wakeup
```

They do not own:

```text
run terminal status
claim settlement
approval result
publish success
```

Those are facts or projections in agentOS/app ledgers. A Workflow step may
invoke `submitRunStream` for product-facing progress, but the stream is still
composition over ledger rows plus a final `SubmitResult`; it is not a workflow
state table.

## vibe Replacement Path

For a vibe-style `workflowRunLedger.ts`, the strangler path is:

```text
Workflow/D1 run table -> SchedulerIntent + derived index
agent loop status     -> submit / submitRunStream result
step state            -> ledger projection
trace lookup          -> ledger refs + derived index
```

This cookbook does not prescribe vibe's product policy. It only fixes the
ownership boundary: scheduling outside, truth inside the agentOS ledger.

## Verification

A scheduled-run implementation is correct when:

- deleting and rebuilding the D1 index from ledger rows preserves product
  projections;
- replaying a scheduler intent from the same cursor is idempotent;
- a scheduler retry cannot commit a second terminal fact for the same intended
  effect;
- a Workflow/queue failure can at worst delay progress, not rewrite run truth.
