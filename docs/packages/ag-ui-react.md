# @agent-os/ag-ui-react

## Purpose

React hooks and stores for consuming AG-UI frames produced by `@agent-os/ag-ui`.

## Invariant

React bindings consume AG-UI frames only. They do not parse ledger payloads,
decode runtime events, or own AG-UI frame mapping semantics.

## Minimal Usage

```ts
import { useAgUiActivities, useAgUiProjection } from "@agent-os/ag-ui-react";
```

Use `createAgUiReactFrameStore` when a product wants appendable frame state.
Use `useAgUiActivities` for a neutral activity feed derived from AG-UI frames.

## Verification

```sh
cd packages/wire-adapters/ag-ui-react
vp test run
```
