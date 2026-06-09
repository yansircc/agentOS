# @agent-os/image-resource-settlement

## Purpose

Effect helper for consuming or releasing image resource reservations around a
provider-side image operation.

## Invariant

The image carrier owns only image.\* vocabulary, idempotency, and projections.
This package owns the Effect implementation helper that wraps provider calls
with resource settlement behavior.

## Minimal Usage

Use `withImageResourceSettlement(effect, settlement)` in provider code that has
already acquired an image resource reservation and must consume it on success or
release it on failure.

## Verification

```sh
cd packages/providers/image-resource-settlement
vp test run
```
