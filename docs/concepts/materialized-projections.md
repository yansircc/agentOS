# Materialized Projections

## Problem

Agent apps need current state without making current state a second source of
truth. Files, run status, skill metadata, credential metadata, ports, and deploy
summaries all need fast reads while remaining rebuildable from durable facts.

## Model

The ledger owns the past. A materialized projection owns a declared fold from
ledger events into current rows.

`defineProjection` declares the projection kind, version, source event kinds,
identity schema, state schema, identity key, initial state, and synchronous
reducer. Backends apply matching reducers in the same transaction as the ledger
commit. If a reducer fails, the ledger commit fails too.

Projection state stores refs and metadata only. Bytes, zip bodies, raw secrets,
provider URLs, tokens, and account ids remain outside ledger-visible state.
Version mismatch reports `needs_rebuild`; rebuild is explicit.

## Non-Goals

Materialized projections do not define app commands, authorization, HTTP routes,
provider idempotency, durable stream recovery, or product-specific workflow
vocabulary.

## Related

- [Durable truth](durable-truth.md)
- [Runtime package](../packages/runtime.md)
- [Runtime API](../api/runtime.md)
