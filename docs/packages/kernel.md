# @agent-os/kernel

## Purpose

Pure agentOS algebra: effect claims, BoundaryContract declarations, symbolic
material refs, tool contracts, context packs, runtime scope refs, and shared
ledger-visible types.

## Invariant

Kernel code has no platform or backend imports. It can validate and name facts,
but cannot commit, schedule, dispatch, resolve concrete material, or construct
runtime responses.

## Minimal Usage

Import claim and boundary helpers from kernel subpaths.

```ts
import { defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
```

## Verification

```sh
cd packages/kernel
bun run test
```
