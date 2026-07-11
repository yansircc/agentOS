# @agent-os/core

## Purpose

`@agent-os/core` owns neutral agentOS substrate algebra: owner identity helpers, value
brands, material refs, boundary contracts, AgentSchema, tool contracts, shared errors,
and provider-neutral runtime, backend, LLM, and telemetry protocol vocabulary.

It contains no runtime service loop, backend interpreter, provider SDK, framework
adapter, target ambient implementation, or disputed event-projection fold.

## Invariant

Core is a neutral axioms package. Package names are build metadata only; durable owner
identity remains the frozen owner id string declared by the owning protocol or carrier.

Backend conformance facts are core algebra. The backend-protocol subpath owns the
protocol version, ordered law manifest, capability matrix, report schema, and positive
validator. It does not import a test runner or execute backend drivers.

Ledger archive segments and receipts are also core protocol facts. Canonical
encoding, SHA-256 verification, exact truth identity, strict event ordering, and
segment-chain validation are provider-neutral; archive storage and eviction remain
runtime/backend responsibilities.

## Minimal Usage

```ts
import { ABORT } from "@agent-os/core";
import { defineAgentBindings } from "@agent-os/core/runtime-protocol";
```

## Verification

```sh
pnpm --filter @agent-os/core test
```
