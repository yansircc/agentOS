# Gated Effect Chain

> **Pattern**: verify a candidate artifact, wait for an app decision, then run
> a serialized publish saga.
> **Pressure evidence**: zeroY3 `verify -> preview -> review -> approve`
> workflow.
> **Uses**: carrier tools, `emitEvent`, `events`, optional `scheduleEvent`,
> optional resource/publish lock.
> **Does NOT introduce**: `runStatus.awaiting_decision`, workflow suspension
> primitive, generic rollback engine, package-owned `verification.*` or
> `deploy.*` vocabulary.

## Generator

A candidate should become live only after:

```text
produce candidate -> verify gates -> preview/review -> operator decision
  -> publish steps -> readback proves live terminal state
```

The same shape covers source patches, schema generation, adapter writes,
preview artifact publication, and production deploy. The gate names and
publish steps are app policy; the algebra is stable.

## Invariant

- Carrier bytes, command logs, build output, deploy manifests, rollback
  material, and previews live in their carriers. Ledger facts store refs and
  small summaries.
- Gate state is a projection over gate facts, not a mutable status table.
- Operator approval is an app fact. It is not a core run status.
- Publish success is terminal only after all required live-side effects and
  readbacks pass.
- A failed publish must not write the live terminal fact.

## App-Owned MVP Facts

Before carrier vocabularies are proven reusable, use an app namespace such as
`change.*`:

```text
change.candidate.recorded
change.gate.recorded
change.ready_for_review
change.approval.decided
change.publish.started
change.publish.step_recorded
change.published
change.publish_failed
change.discarded
```

Example payloads:

```ts
type GateFact = {
  changeId: string
  gate: "typecheck" | "build" | "adapter-readback" | "preview-smoke"
  status: "passed" | "failed"
  proofRef: string
  fingerprint: string
}

type ReadyFact = {
  changeId: string
  gateEventIds: ReadonlyArray<number>
  previewRef?: string
}

type PublishStepFact = {
  changeId: string
  step:
    | "merge-main"
    | "adapter-apply"
    | "adapter-readback"
    | "deploy-production"
    | "production-readback"
    | "staging-gc"
  status: "passed" | "failed"
  proofRef: string
}
```

Do not use `verification.*`, `deploy.*`, `git.*`, or `staging.*` until those
packages own the prefix through spec-34 positive extension capability. In the
MVP, carrier tools return proof refs through `tool.executed.result`; the host
app commits `change.*` facts from those proofs.

## Projection

Reviewability is derived:

```ts
function projectReady(
  events: ReadonlyArray<LedgerEventRpc>,
  changeId: string,
  requiredGates: ReadonlyArray<string>,
) {
  const latestByGate = new Map<string, LedgerEventRpc>();

  for (const event of events) {
    if (event.kind !== "change.gate.recorded") continue;
    if (event.payload.changeId !== changeId) continue;
    latestByGate.set(event.payload.gate, event);
  }

  const passed = requiredGates.every((gate) => {
    const event = latestByGate.get(gate);
    return event?.payload.status === "passed";
  });

  return {
    ready: passed,
    gateEventIds: [...latestByGate.values()].map((event) => event.id),
  };
}
```

The app may commit `change.ready_for_review` after `projectReady(...).ready`
is true. That fact is a durable marker for the workbench and audit trail, not a
second source of truth for gate state.

## Publish Saga

Publish starts only after re-projecting the current ledger:

```text
assert latest gates pass
assert approval winner is approve
assert no publish lock is active
commit change.publish.started(idempotencyKey)
run publish steps serially
commit change.publish.step_recorded for each step
commit change.published only after production readback proves the change live
```

Failure path:

```text
commit change.publish_failed(step, proofRef, reason)
leave change non-live
do not commit change.published
```

External providers are not assumed to be transactional. "All-or-nothing" means
the app does not declare the change live until every required proof exists. If
a carrier needs compensation, it must return rollback refs, and the app/carrier
owns that compensation policy.

## Decision Point

Operator-in-the-loop stays app-composed:

```text
agent delivers change.ready_for_review
operator emits change.approval.decided
app handler starts publish saga when projection still allows it
```

`runStatus` remains an objective submit projection:

```text
delivered | aborted | open_without_terminal | orphaned
```

There is no `awaiting_decision` core state. Waiting for approval is app saga
state projected from `change.ready_for_review`, `change.approval.decided`, and
optional timeout facts.

## Idempotency

Every carrier mutation step needs an idempotency key:

```text
<siteId>/<changeId>/<publishAttempt>/<step>
```

Repeated handlers must project before mutating. If `change.published` already
exists for the change, the handler returns the existing terminal projection.
If `change.publish_failed` exists for the same attempt, the handler must not
continue that attempt.

## Graduation

After pressure evidence proves stable nouns across apps, extract optional
packages:

```text
@agent-os/git-carrier
@agent-os/verification
@agent-os/deploy-cloudflare
@agent-os/staging-artifact
```

Those packages may then claim protected vocabularies:

```text
git.*
verification.*
deploy.*
staging.*
```

Package-owned facts require spec-34 positive extension capability. Until then,
the reusable package boundary is tool result shape plus proof refs, not
protected ledger vocabulary.

The first package cut should be proof/projection only: prefix declaration,
event constants, payload types, carrier backend interfaces, and projection
helpers. Real provider mutation and positive package commits are separate
implementation phases.

## Verification

A pressure test for this recipe should prove:

- publish cannot start unless latest required gates pass;
- approval before `ready_for_review` does not publish;
- duplicate approval does not duplicate publish effects;
- failed publish does not write `change.published`;
- discard removes active carrier state and never writes production facts;
- production-visible readback is required before `change.published`;
- app-facing writes cannot forge future package prefixes once registered.

Passing one observed happy path is not enough. The class is handled when every
live transition is derived from ledger facts and no mutable status table can
contradict the carrier proofs.
