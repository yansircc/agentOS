# @agent-os/core

## Purpose

Core agentOS substrate: Durable Object base, ledger, submit loop, effect claims,
material refs, tools, quotas, dispatch, extension capabilities, context
packing, and boundary contracts.

## Public API Status

0.2.x active development. Public exports are listed in `PUBLIC_API.md` to
prevent accidental exports; they are not frozen.

## Invariant

Ledger facts are durable truth. `PreClaim` names effect identity;
`MaterialRef` names execution means; projections are derived data. Resolved
material never enters ledger-visible payloads.

## Minimal Usage

Extend `AgentDOBase`, register tools with `defineRegisteredTool`, resolve
execution material through `provideRefResolver`, and submit work through
`submit`.

```ts
import { AgentDOBase } from "@agent-os/core";
import { defineRegisteredTool } from "@agent-os/core/tools";
```

## Verification

```sh
cd packages/core
vp test run
```
