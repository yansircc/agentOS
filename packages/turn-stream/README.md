# @agent-os/turn-stream

## Purpose

Non-durable token and progress frame algebra.

## Public API Status

1.0 target for frame algebra. Frozen exports are listed in `PUBLIC_API.md`.

## Invariant

Turn frames are UI/progress data. They are not ledger facts and do not settle
claims.

## Minimal Usage

Use provider adapters or transport packages to convert token deltas into
`TurnStreamFrame` values, then pass them to run-stream composition when needed.

## Verification

```sh
cd packages/turn-stream
vp test run
```
