# @agent-os/run-stream

`@agent-os/run-stream` is a composition package. It does not submit runs, write
ledger events, or own durable run truth.

## Invariant

Durable run truth is the ledger plus terminal `SubmitResult`. Turn frames are
non-durable UI/progress data. A run-stream projection may combine those inputs,
but it must not become a second run state.

## Frames

`RunStreamFrame` has four variants:

- `ledger_event`: durable source frame from the agentOS ledger;
- `turn_frame`: non-durable UI/progress frame from `@agent-os/turn-stream`;
- `submit_result`: terminal submit result, `ok=true` or `ok=false`;
- `stream_error`: terminal composition/transport failure.

`stream_error` never means claim settlement failed. Claim settlement remains in
the ledger/result path that produced the source frames.

## Batched Bridge

`composeBatchedSubmitRunStream`:

1. reads a baseline ledger cursor unless `afterId` is supplied;
2. waits for `submit(submitSpec)` to finish;
3. reads post-baseline ledger rows;
4. emits ledger frames followed by terminal `submit_result`.

This is explicitly not live progress. It is useful when a consumer wants one
SSE-shaped response containing durable post-submit rows and the terminal result.

## Realtime Composition

`composeRealtimeRunStream` consumes:

- a live ledger event source;
- an optional live turn-frame source;
- a terminal `SubmitResult` promise;
- an optional cancellation signal.

Ordering is source-arrival order. The composer assigns `seq` when a source
value wins the race, so a `ledger_event` or `turn_frame` can arrive before the
terminal `submit_result`.

Terminal rules:

- `submit_result.ok=true` terminates with status `succeeded` in projection;
- `submit_result.ok=false` terminates with status `failed` in projection;
- malformed source frames terminate with `stream_error`;
- source promise/iterator failures terminate with `stream_error`;
- submit promise rejection terminates with `stream_error`;
- cancellation terminates with `stream_error` reason `stream_aborted`.

After any terminal frame, source iterators are closed. Iterator close failures
propagate to the consumer; there is no fallback to batched mode.

## Ownership

The package owns frame algebra, SSE encode/decode, projections, and composition
over caller-provided sources. It does not own:

- `submit`;
- ledger event subscription;
- provider token streaming;
- retry or approval policy;
- durable run indexes.
