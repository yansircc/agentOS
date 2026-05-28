# @agent-os/backend-in-memory

## Purpose

In-memory backend instance for runtime contract tests and local backend parity
checks.

## Invariant

Runtime Tags are the backend contract. The in-memory backend implements the same
Ledger, Scheduler, Dispatch, Resources, Quota, Admission, and LlmTransport Tag
surface without importing Cloudflare or SQL substrate APIs.

## Minimal Usage

Create an in-memory runtime backend in tests.

```ts
import { createInMemoryRuntimeBackend } from "@agent-os/backend-in-memory";
```

## Verification

```sh
cd packages/backend-in-memory
bun run test
```
