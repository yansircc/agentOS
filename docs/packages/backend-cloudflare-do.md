# @agent-os/backend-cloudflare-do

## Purpose

Cloudflare Durable Object backend for agentOS: app facade, DO storage,
transactions, alarms, SSE streaming, dispatch delivery, and Cloudflare binding
materialization.

## Invariant

Cloudflare-specific APIs stay in this backend. Shared kernel/runtime packages
must not import Durable Object state, Worker bindings, or alarm APIs.

Application code registers app-owned durable triggers only through the facade
configuration. `defineAgentDO({ triggers })` is the Cloudflare DO construction
surface for trigger registration; the backend builds the registry, validates
duplicate kinds, and uses that same registry for submit and drain. Apps must
not import `runtime-core`, `due-work`, SQL helpers, inserted-event helpers, or
backend state internals.

## Minimal Usage

Create a DO class from one app-facing facade config. `bindings` is the only
material declaration surface; LLM routes reference symbolic ids.

```ts
import { credential, defineAgentDO, endpoint, openAIChat } from "@agent-os/backend-cloudflare-do";
import { defineTool } from "@agent-os/kernel/tools";
import { Schema } from "effect";

const lookup = defineTool({
  name: "lookup",
  description: "Look up a symbolic key.",
  args: Schema.Struct({ key: Schema.String }),
  authority: "read",
  admit: "allow",
  execute: ({ key }) => ({ value: key }),
});

export const AgentDO = defineAgentDO<Env>({
  bindings: [
    endpoint("llm").from((env) => env.LLM_ENDPOINT),
    credential("llm-key").from((env) => env.LLM_KEY),
  ],
  llms: {
    default: openAIChat({
      model: "gpt-4.1-mini",
      endpoint: "llm",
      credential: "llm-key",
    }),
  },
  tools: [lookup],
});
```

App triggers use runtime trigger types and the same facade registration path as
built-in triggers.

```ts
import { defineAgentDO } from "@agent-os/backend-cloudflare-do";
import type { AnyDurableTrigger } from "@agent-os/runtime";

const appTriggers = [imageScanTrigger] satisfies ReadonlyArray<AnyDurableTrigger>;

export const AgentDO = defineAgentDO<Env>({
  bindings: [],
  triggers: appTriggers,
});
```

Omit `llms` for event-only facades. They keep `emit`, `schedule`, `dispatch`,
`on`, `bindings`, and extensions, but do not expose `submit`. Full
`SubmitSpec` remains on the low-level `createAgentDurableObject` API.

## Verification

```sh
cd packages/backends/cloudflare-do
bun run test
```
