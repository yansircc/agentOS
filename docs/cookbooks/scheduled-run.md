# Scheduled Run

> **Pattern**: a workflow scheduler triggers ordered effects, but
> agentOS ledger remains the single source of run truth; the scheduler holds
> only its own step state and any external index (D1, KV) is a derived
> projection.
> **Pressure evidence**: vibe's Cloudflare Workflow + D1 + ledger pipeline
> and zeroY's `@effect/workflow` step graph + CST as task truth. The
> _scheduler ≠ truth_ principle holds in both, but zeroY uses CST as its
> truth store rather than the agentOS ledger; this cookbook treats CST as
> an analogue and the cross-product evidence is "analogous N=1", not
> equivalent N=2. See `docs/notes/zeroY-n2-stability-audit.md` for the
> source pin and exact analogy boundary.
> **Uses**: `submit`, `ledger`, `streamEvents`, `dispatch`, `EffectClaim`,
> optional `@agent-os/decision-gate`, optional `@agent-os/run-stream`.
> **Does NOT introduce**: a workflow `Pending` phase, a second durable
> source of run truth, scheduler-as-ledger, or a generic rollback engine.

## Invariant

```text
scheduler holds step intent    -> sees only its own progress
ledger holds run truth         -> sees every committed effect
external index mirrors ledger  -> sees a derived view, never authoritative
```

Three layers, one fact source. If the scheduler crashes mid-run, replay must
reconstruct progress from the ledger cursor and the scheduler's own intent
table, never from the external index. The index can be rebuilt from the
ledger at any time.

Corollaries:

- **S-1.** A scheduler step is a generator of one or more `PreClaim`s. It
  is not itself an effect claim.
- **S-2.** A workflow "completed" record is scheduler-local. The product's
  notion of run completion is the ledger terminal fact (`agent.run.completed`
  or carrier terminal anchor), not the scheduler's done state.
- **S-3.** Resume is from the ledger cursor. After a crash, the scheduler
  re-derives "what already happened" by reading committed events for the
  affected operationRefs, not by querying its own resumed step state in
  isolation.
- **S-4.** Index writes (D1 row, KV entry) are projections. A row missing
  from the index because the projection has not caught up is not a
  contradiction with the ledger; the index simply lags.

## Generator

A long-running product wants ordered steps with retries, waits, and
visibility outside a single DO lifetime:

```text
intent ->
  step 1 mints PreClaim -> effect settles to ledger -> step 1 done
  step 2 mints PreClaim -> effect settles to ledger -> step 2 done
  ...
  scheduler done (advisory)
  ledger terminal fact (authoritative)
```

The scheduler may be a Cloudflare Workflow class, `@effect/workflow`, a
queue with alarms, or any other ordered driver. The substrate does not
constrain which.

The scheduler's responsibility is **only** ordering, retries, and waits. It
must not store the values produced by the effects beyond what it needs for
its own next step. The ledger is where those values become durable.

## Three Tier Truth

```text
Tier 1 (truth):   ledger events committed by carriers
Tier 2 (intent):  scheduler step records (workflow state, alarm queue, etc.)
Tier 3 (derived): external indexes for cross-DO query and UI
```

Tier 2 is necessary because schedulers need their own resume state. It is
not authoritative for product semantics.

Tier 3 (D1 mirror, KV index, search index) is purely derived. It is built
by reading ledger events and projecting into a query shape. Failures to
update Tier 3 do not invalidate Tier 1.

## App-Owned MVP Facts

Until a carrier vocabulary stabilizes for "this scheduler runs this kind of
saga", use an app-scoped namespace such as `pipeline.*`:

```text
pipeline.scheduled        scheduler intent recorded; carries operationRef
pipeline.step_started     scheduler is about to mint a step PreClaim
pipeline.step_completed   scheduler observed the step's LivedClaim
pipeline.step_rejected    scheduler observed a RejectedClaim
pipeline.completed        scheduler reached its done state
```

`pipeline.scheduled` and the step transitions are scheduler-local. They are
not effect claims; they are intent records. The effect claims live where
each carrier already commits them (`tool.executed`, `git.commit.recorded`,
`workspace_session.started`, etc.).

When the product has enough pressure to name a stable scheduler vocabulary,
move from `pipeline.*` to a carrier-owned prefix and declare it as an
`ExtensionPackage`. Spec-34 still applies: vocabulary ownership stays
positive and capability-gated.

## OperationRef linkage

The scheduler mints each step's `operationRef` deterministically so resume
is idempotent:

```text
operationRef = namespace ":" scheduler-id ":" execution-id ":" step-id
```

Same scheduler invocation, same step, same operationRef. A retry uses the
same operationRef; spec-36 §3 O-3 ensures the carrier's idempotency layer
returns the same terminal settlement.

Cross-step lineage uses `originRef`:

```text
step N's PreClaim.originRef = { originId: scheduler-id ":" execution-id,
                                originKind: "scheduler" }
```

This lets the trace projection group all step claims into a single
schedule's lineage without inventing a new ref type.

## Compensation chains

A scheduler may declare a compensation step per primary step. Compensation
fires when the primary step settles to RejectedClaim or when a downstream
step requires unwinding work already done.

Pressure evidence is **N=1**: zeroY declares one such edge —
`locwp_apply -> rollback` in
`packages/workflows/src/index.ts:205-249` — with `mode:
"rollback_on_failure"`. No other product yet exhibits the convention. The
shape below is therefore an agentOS cookbook proposal motivated by that
single edge, not a cross-product-validated convention. A second product's
compensation pattern may push the linking shape in another direction.

```text
primary step mints PreClaim                 -> LivedClaim or RejectedClaim
on RejectedClaim or downstream failure:
  compensation step mints NEW PreClaim      -> settles to its own terminal
```

Compensation is **not** an EffectClaim phase. RejectedClaim remains
terminal. The compensation is a follow-on effect chain.

Proposed linking convention:

```text
compensation.PreClaim.originRef = {
  originId:    primary.operationRef,
  originKind:  "compensation_of",
}
```

The compensation claim's anchor or rejection records the compensation
outcome. A failed compensation produces its own RejectedClaim. The scheduler
decides whether to escalate, mark the run dead-letter, or notify an
operator. None of this requires a new substrate phase.

Trace readers find the chain by following originRef back from compensation
claims to their primary operationRefs. Failure-plane readers see both the
primary RejectedClaim and the compensation's terminal claim as separate
entries; they share a common operationRef prefix only by app convention,
not by core schema.

If a third product exhibits compensation chains with a different linking
shape (for example, multi-level compensation-of-compensation), this
convention may need spec-level naming. Until then it stays a cookbook
convention.

## Replay invariant

After a scheduler restart:

```text
1. Load scheduler's own step state from Tier 2 (workflow runtime, alarm
   queue, or app DB).
2. For each step that the scheduler thinks completed, read the ledger to
   confirm the terminal claim exists. If absent, the step did not actually
   commit; re-mint the same PreClaim and try again. Idempotency is
   guaranteed by operationRef.
3. For each step the scheduler thinks failed, read the ledger for the
   RejectedClaim. If present, run compensation (if declared) and proceed.
   If absent, the step never finished; retry.
4. Tier 3 catch-up happens asynchronously from the ledger stream.
```

A scheduler that trusts only its own Tier 2 state without checking the
ledger may double-execute effects on restart. The carrier's idempotency
layer (`tool.executed` dedup, dispatch outbox, etc.) prevents duplicate
external effects, but the scheduler's own state cannot be the truth.

## Index projection

Index writes (D1 mirror, KV entry, search shard) consume the ledger event
stream and produce derived rows. They follow the reader guard from spec-36
§11 M-4: they do not become a second source of truth.

A typical index row carries:

```text
runId / operationRef / scope / phase / anchor or rejection / ts
```

If the index falls behind, queries against it return stale data; queries
against the ledger always return current data. The product chooses which
endpoint to expose to which consumer.

## Consumer stream boundary

A scheduled workflow may expose a consumer-facing stream, but the stream is
still a composition over ledger facts and terminal results. It must not become
a workflow state table.

The current `@agent-os/run-stream` submit bridge is batched:

```text
submit completes
read post-baseline ledger rows
emit run-stream frames + terminal SubmitResult
```

It is useful for terminal delivery and replay-friendly UI handoff. It is not
live progress. Realtime UI needs a separate non-durable turn-frame source, and
those turn frames remain progress data rather than durable truth.

## vibe replacement path

For a vibe-style `workflowRunLedger.ts`, the strangler path is:

```text
Workflow/D1 run table -> SchedulerIntent + derived index
agent loop status     -> submit result + run-stream projection
step state            -> ledger projection
trace lookup          -> ledger refs + derived index
```

This cookbook does not prescribe vibe's product policy. It only fixes the
ownership boundary: scheduling outside, truth inside the agentOS ledger.

## Why this is one cookbook, not two

vibe and zeroY use different schedulers (Cloudflare Workflow vs
`@effect/workflow`) and different external indexes (both happen to use D1,
but the shape differs). They share the same invariant: scheduler ordering,
ledger truth, index projection. The cookbook captures the invariant and
leaves the scheduler and index implementations to the product.

A future `@agent-os/scheduled-run` package may emerge if both products
converge on a common scheduler abstraction. Today the package would have
exactly one shared interface (the ledger-cursor resume helper) and two
divergent backends, which is not enough surface area to warrant a package.
Cookbook is the right shape until that changes.

## Verification

When applying this pattern, the product should be able to answer:

- Where is the run's authoritative terminal state recorded? It must be a
  ledger event, not a scheduler row.
- If the index is dropped and rebuilt from the ledger, is the result
  equivalent to the current index? It must be.
- After a forced scheduler crash mid-run, does replay re-execute committed
  effects? It must not (idempotency by operationRef).
- If a compensation step fails, does the scheduler still claim the run
  succeeded? It must not.
- Can a reader find all steps of a single scheduler execution by following
  originRef without joining against scheduler-local tables? It must be able
  to.

If any of these answers is "no", the implementation has collapsed one of
the three tiers into another and lost the invariant.
