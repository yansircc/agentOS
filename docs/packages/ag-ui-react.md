# @agent-os/ag-ui-react

## Purpose

Legacy React hooks and stores for consuming AG-UI frames produced by
`@agent-os/ag-ui`.

## Invariant

This package is retired by the canonical client migration. It must not gain new
surface area. React binding ownership moves to `@agent-os/client-react`, which
bridges the framework-neutral `@agent-os/client` store.

## Minimal Usage

```ts
import { useAgUiActivities, useAgUiProjection } from "@agent-os/ag-ui-react";
```

Existing exports remain declared only until the package is deleted by the
frontend package collapse phase. New consumers should not target this package.

## Verification

```sh
cd packages/wire-adapters/ag-ui-react
vp test run
```
