# Hello Ledger Event

## Goal

Append one event to the runtime ledger and read it back as durable truth.

## What You Build

A local in-memory runtime proof that writes `tutorial.hello.recorded` and reads
the same event through `Ledger.events`.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Runtime package](../packages/runtime.md)
- [In-memory backend](../packages/backend-in-memory.md)

## Steps

1. Create an in-memory backend state and runtime layer:

   ```ts
   import { Effect } from "effect";
   import { Ledger } from "@agent-os/runtime";
   import { InMemoryBackendState, InMemoryLedgerLive } from "@agent-os/runtime/in-memory";

   const scope = "tutorial:hello";
   const state = new InMemoryBackendState();
   const ledgerLayer = InMemoryLedgerLive(state);
   ```

2. Append one domain event:

   ```ts
   const program = Effect.gen(function* () {
     const ledger = yield* Ledger;
     yield* ledger.commit([
       { kind: "tutorial.hello.recorded", payload: { message: "hello" }, scope },
     ]);
     return yield* ledger.events(scope);
   });
   ```

3. Run the proof:

   ```ts
   const events = await Effect.runPromise(program.pipe(Effect.provide(ledgerLayer)));
   ```

4. Treat the returned rows as facts. Do not copy them into another mutable
   "current state" object.

## Checkpoint

The readback contains exactly the event you appended:

```ts
events.map((event) => event.kind); // ["tutorial.hello.recorded"]
events[0]?.payload; // { message: "hello" }
```

The event is the source of truth. Any UI state or projection must be derived by
folding the event list.

## Next

Let an LLM call a tool with [weather tool LLM loop](weather-tool-llm-loop.md).
