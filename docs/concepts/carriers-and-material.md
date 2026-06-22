# Carriers And Material

## Problem

Agent facts need to prove work without leaking provider tokens, live handles,
raw assets, or tenant-specific material.

## Model

Carriers own symbolic event vocabulary and projections. Material resolvers own
provider-specific credentials, endpoints, and resource handles. Ledger payloads
may contain symbolic refs and proof refs; resolved provider material stays at
execution time.

Only packages that share the `defineCarrier` generator are carrier packages.
Similar-looking policy, settlement, or lifecycle shapes do not justify a shared
carrier abstraction unless they also share event vocabulary, claim settlement,
authority/material declaration, and derived projection generation. Execution
domains such as sandbox and WorkspaceEnv are separate locus/actuator surfaces,
not carriers.

## Non-Goals

This concept does not choose tenant auth policy or provider API topology.

## Related

- [Boundary contract](../boundary-contract.md)
- [Runtime packages](../runtime-packages.md)
- [Carrier reference](../reference/carriers.md)
