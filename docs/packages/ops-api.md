# @agent-os/ops-api

## Purpose

Ops HTTP API for runtime projections.

## Invariant

Ops API is a terminal adapter. It may expose runtime-derived views, but it does
not own ledger truth or substrate invariants.

## Minimal Usage

Use this package from ops tooling, not from carrier or substrate packages.

```ts
import { mountOpsApi } from "@agent-os/ops-api";
```

## Verification

```sh
cd tooling/ops-api
vp test run
```
