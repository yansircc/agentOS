# @agent-os/ops-htmx

## Purpose

HTMX ops console for `@agent-os/ops-api`.

## Invariant

Ops UI state is derived from ops API/runtime projections. It is not ledger truth
and must not introduce shadow state.

## Minimal Usage

Use this package as the terminal ops UI adapter.

```ts
import { mountOpsHtmx } from "@agent-os/ops-htmx";
```

## Verification

```sh
cd tooling/ops-htmx
vp test run
```
