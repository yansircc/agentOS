# Batch Vs Stream Substrate

## Problem

Durable triggers and live sessions have different shapes and should not be
forced into one primitive.

## Model

Batch substrate runs one acquire and one terminal commit. Stream substrate
attaches a live transport that can accept and emit multiple frames before one
terminal settlement. Both can settle durable facts, but only terminal stream
settlement writes truth.

## Non-Goals

This concept does not require every stream frame to be durable or every trigger
to become interactive.

## Related

- [Durable truth](durable-truth.md)
- [Attached streams](attached-streams.md)
