# @agent-os/llm-transport-http

Status: internal-stable, public-experimental.

## Invariant

HTTP LLM streaming is non-durable turn progress. Durable run truth remains the
terminal `SubmitResult` plus ledger events.

This package is the HTTP provider materialization of the LLM protocol surface
owned by `@agent-os/core`; there is no separate provider-neutral
`@agent-os/llm-transport` algebra package.

`streamLlmTurn`:

- resolves endpoint and credential material only through the supplied
  `RefResolver`;
- does not read environment variables;
- does not write ledger events;
- emits only `@agent-os/turn-stream` frames;
- does not expose provider secrets or raw provider bodies in frames.

## Realtime Wiring

```ts
import { streamLlmTurn } from "@agent-os/llm-transport-http";
import { composeRealtimeRunStream } from "@agent-os/run-stream";

const turnFrames = streamLlmTurn({
  route,
  resolver,
  messages,
  tools,
  turnRef,
  fetch,
  signal,
});

const runFrames = composeRealtimeRunStream({
  ledgerEvents,
  turnFrames,
  submitResult,
  signal,
});
```

`turnFrames` are progress only. `composeRealtimeRunStream` still terminates from
`submitResult`; ledger events and the submit result remain the durable truth.
