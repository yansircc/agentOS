# @agent-os/backend-in-memory

## Purpose

In-memory backend instance for runtime contract tests and local backend parity
checks.

## Invariant

CommitJournal fanout is owned by the commit path: successful transactions fire
inserted events exactly once, and failed transactions persist and fire nothing.

## Minimal Usage

Create an in-memory CommitJournal in tests.

```ts
import { createInMemoryCommitJournal } from "@agent-os/backend-in-memory";
```

## Verification

```sh
cd packages/backend-in-memory
bun run test
```
