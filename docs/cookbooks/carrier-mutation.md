# Carrier Mutation

> **Pattern**: mutate external state while keeping the ledger as audit truth.
> **Pressure evidence**: file/WP/R2 style carrier mutations in app scans.
> **Uses**: Tool execution, `emitEvent`, `dispatchToScope`, carrier-owned
> artifact refs.
> **Does NOT introduce**: generic carrier abstraction, blob table, rollback
> engine.

## Generator

A tool touches state that the ledger cannot and should not own:

- filesystem or workspace files
- WordPress/plugin state
- R2 objects
- external provider artifacts
- large command/deploy logs

The carrier owns bytes and mutation mechanics. The ledger owns the small proof
needed to audit, resume, or compensate.

## Pattern Code

```ts
const applyPatchTool: Tool<ApplyArgs, ApplyResult> = {
  definition: {
    /* JSON Schema */
  },
  execute: async (args) => {
    const result = await carrier.apply(args);

    return {
      status: result.partialFailure ? "partial" : "ok",
      artifactRef: result.artifactRef,
      rollbackRef: result.rollbackRef,
      summary: result.summary,
    };
  },
};
```

The tool result becomes a ledger event through the normal submit loop:

```text
tool.executed {
  name,
  args,
  result: {
    status,
    artifactRef,
    rollbackRef,
    summary
  }
}
```

If the app later compensates, write a second fact:

```ts
await this.emitEvent({
  event: "tool.rollback_executed",
  data: {
    originalToolEventId,
    rollbackRef,
    artifactRef,
    status: "ok",
  },
});
```

## Invariants Preserved

- Ledger stores refs and summaries, not carrier bytes.
- Carrier-specific state shape does not leak into shared substrate logic.
- Rollback evidence is durable because the reference is in the ledger.
- Cleanup policy stays with the carrier/app that owns the state root.

## Common Mistakes

- Writing full file contents, HTML pages, command logs, or base64 blobs into
  ledger payloads.
- Treating an R2 object key as substrate-owned. The key scheme is app/carrier
  policy.
- Returning only "ok" from a carrier mutation. Without an artifact or rollback
  ref, later compensation has no durable handle.
- Building a second mutable status table for carrier state. Project from
  ledger refs and carrier existence checks instead.

## Graduation Watchlist

If two independent apps converge on the same artifact registry shape, graduate
that registry to an optional helper package. Core should change only if the
ledger needs a new transaction boundary, which carrier mutation does not
currently require.
