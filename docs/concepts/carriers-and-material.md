# Carriers And Material

## Problem

Agent facts need to prove work without leaking provider tokens, live handles,
raw assets, or tenant-specific material.

## Model

Carriers own symbolic event vocabulary and projections. Material resolvers own
provider-specific credentials, endpoints, and resource handles. Ledger payloads
may contain symbolic refs and proof refs; resolved provider material stays at
execution time.

## Non-Goals

This concept does not choose tenant auth policy or provider API topology.

## Related

- [Boundary contract](../boundary-contract.md)
- [Runtime packages](../runtime-packages.md)
- [Resource carrier](../packages/resource-carrier.md)
