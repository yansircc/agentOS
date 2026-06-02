# @agent-os/backend-in-memory

## Purpose

In-memory backend instance for runtime contract tests and local backend parity
checks.

## Invariant

Runtime Tags are the backend contract. The in-memory backend implements the same
Ledger, Scheduler, Dispatch, Resources, Quota, Admission, and LlmTransport Tag
surface without importing Cloudflare or SQL substrate APIs.

The in-memory backend accepts only pure `ReadonlyArray<AnyDurableTrigger>`
registrations. It does not accept backend-bound trigger factories and does not
model app-owned projection tables. Projection-touching triggers are
Cloudflare-bound until a second production backend or second app proves a
shared projection adapter shape.

For pure trigger parity tests, the in-memory backend mirrors durable trigger
claim, cancel, and redrive semantics: expired claims become claimable again,
`cancelTrigger` respects each trigger's `cancellation` declaration, and
claim-token checks prevent duplicate terminal facts. It does not model
Cloudflare isolate eviction or backend-local projection writes.

## Minimal Usage

Create an in-memory runtime backend in tests.

```ts
import { createInMemoryRuntimeBackend } from "@agent-os/backend-in-memory";
```

## Verification

```sh
cd packages/backends/in-memory
bun run test
```
