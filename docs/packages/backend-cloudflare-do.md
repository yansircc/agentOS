# @agent-os/backend-cloudflare-do

## Purpose

Cloudflare Durable Object backend for agentOS: DO storage, transactions,
alarms, SSE streaming, dispatch delivery, and Cloudflare binding
materialization.

## Invariant

Cloudflare-specific APIs stay in this backend. Shared kernel/runtime packages
must not import Durable Object state, Worker bindings, or alarm APIs.

## Minimal Usage

Create a DO class from explicit backend config.

```ts
import { createAgentDurableObject } from "@agent-os/backend-cloudflare-do";

export class AgentDO extends createAgentDurableObject({}) {}
```

## Verification

```sh
cd packages/backends/cloudflare-do
bun run test
```
