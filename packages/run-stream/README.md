# @agent-os/run-stream

## Purpose

Composition package for ledger events, optional turn frames, and terminal
submit results.

## Public API Status

0.2.x active development for frame algebra and batched/realtime composition.
Public exports are listed in `PUBLIC_API.md` to prevent accidental exports;
they are not frozen.

## Invariant

Run-stream does not submit runs, write ledger events, or own durable run truth.
It composes source frames into consumer frames and projections.

## Minimal Usage

Use batched composition when terminal aggregation is enough. Use realtime
composition when the caller supplies live ledger and turn-frame sources.

```ts
import { composeRealtimeRunStream } from "@agent-os/run-stream";
```

`stream_error` means transport or composition failure, not claim settlement
failure.

## Verification

```sh
cd packages/run-stream
vp test run
```
