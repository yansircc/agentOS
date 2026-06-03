# Durable Truth

## Problem

Agent applications need a source of truth that survives retries, process
eviction, UI disconnects, and provider failures.

## Model

The ledger is durable truth. Triggers append terminal facts. Projections fold
ledger facts and never write shadow truth. Transport frames, provider material,
and local UI state are not truth unless a handler commits them as facts.

## Non-Goals

This concept does not define live streaming, provider credentials, or
application authorization.

## Related

- [Attached streams](attached-streams.md)
- [Materialized projections](materialized-projections.md)
- [Boundary contract](../boundary-contract.md)
- [Runtime package](../packages/runtime.md)
