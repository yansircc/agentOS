# @agent-os/runtime

## Purpose

Backend-neutral runtime contracts: submit/run API types, admission projection
algebra, and runtime ports such as CommitJournal, TimerBackend, ScopeRouter, and
MaterialResolver.

## Invariant

Runtime code expresses programs against ports. It does not import Worker
modules, Durable Object state, SQL storage implementations, or platform alarm
APIs.

## Minimal Usage

Depend on runtime for consumer-facing run, admission, and port types.

```ts
import type { CommitJournal, SubmitSpec } from "@agent-os/runtime";
```

## Verification

```sh
cd packages/runtime
bun run test
```
