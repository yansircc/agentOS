# @agent-os/runtime

## Purpose

Backend-neutral runtime programs and Effect Tag contracts: submit/run API types,
boundary commit enforcement, dispatch/scheduler/resource/quota/admission
algebra, and ledger-derived projections.

## Invariant

Runtime code expresses programs against Effect Tags. It does not import Worker
modules, Durable Object state, SQL storage implementations, or platform alarm
APIs.

## Minimal Usage

Depend on runtime for consumer-facing run, admission, and backend-neutral Tag
types.

```ts
import type { Ledger, SubmitSpec } from "@agent-os/runtime";
```

## Verification

```sh
cd packages/runtime
bun run test
```
