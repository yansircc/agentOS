# Approval Race

> **Pattern**: wait for an external decision or a timeout, whichever ledger
> fact lands first.
> **Pressure evidence**: zeroY approval wait flow.
> **Uses**: `emitEvent`, `scheduleEvent`, `on`, `events`, optionally
> `streamEvents`.
> **Does NOT introduce**: workflow suspension primitive, in-memory waiter,
> timeout table.

## Generator

Control leaves the agent and returns as one of two facts:

- human/system decision: `approval.decided`
- timeout: `approval.timeout`

The winner is not "which handler ran first"; the winner is the first ledger
row by `id ASC` for the same app correlation key.

## Pattern Code

```ts
async function requestApproval(do_: AgentDOBase<Env>, runId: string) {
  await do_.emitEvent({
    event: "approval.requested",
    data: { runId },
  });

  await do_.scheduleEvent({
    event: "approval.timeout",
    data: { runId },
    at: Date.now() + 24 * 60 * 60 * 1000,
  });
}

async function projectApprovalWinner(
  do_: AgentDOBase<Env>,
  runId: string,
) {
  const candidates = (await do_.events({
    kinds: ["approval.decided", "approval.timeout"],
  }))
    .filter((event) => event.payload.runId === runId)
    .sort((a, b) => a.id - b.id);

  return candidates[0] ?? null;
}
```

Handlers may run on both paths. Each handler must project the winner before
mutating app state:

```ts
this.on("approval.decided", async (event) => {
  const winner = await projectApprovalWinner(this, event.payload.runId);
  if (winner?.id !== event.id) return;
  await continueApproved(event.payload);
});

this.on("approval.timeout", async (event) => {
  const winner = await projectApprovalWinner(this, event.payload.runId);
  if (winner?.id !== event.id) return;
  await continueTimedOut(event.payload);
});
```

## Invariants Preserved

- Ledger row order is the SSoT for the race result.
- Timeout is a scheduled fact, not a background process.
- Decision is an app fact, not a substrate event.
- No waiter state exists outside the ledger.

## Common Mistakes

- Treating handler execution order as truth. It is not durable.
- Deleting/cancelling the timeout row. Prefer projection; cancellation becomes
  another mutable control path.
- Storing a separate `approval_status` table. That duplicates the winner
  projection.

## Graduation Watchlist

If two independent apps copy this projection and handler guard pattern, extract
an optional helper package. Do not move it into core unless the current
`emitEvent` + `scheduleEvent` + `events` composition becomes incorrect by
construction, not merely verbose.
