# Provider Material Binding

## Goal

Declare provider endpoint and credential material without leaking resolved
values into ledger facts.

## What You Build

One `defineAgentDO` binding set with symbolic refs for an OpenAI-compatible LLM
route.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Usage surfaces](../usage-surfaces.md)
- [Cloudflare DO minimal app](cloudflare-do-minimal-app.md)

## Steps

1. Define the environment shape:

   ```ts
   import {
     credential,
     endpoint,
     openAIChat,
     type CloudflareAgentEnv,
   } from "@agent-os/backend-cloudflare-do";

   interface Env extends CloudflareAgentEnv {
     readonly OPENAI_BASE_URL: string;
     readonly OPENAI_API_KEY: string;
   }
   ```

2. Declare material refs at construction:

   ```ts
   const bindings = [
     endpoint<Env>("llm").from((env) => env.OPENAI_BASE_URL),
     credential<Env>("llm-key", { provider: "openai", purpose: "chat" }).from(
       (env) => env.OPENAI_API_KEY,
     ),
   ];
   ```

3. Build the route from symbolic refs:

   ```ts
   const chatRoute = openAIChat({
     model: "gpt-4.1-mini",
     endpoint: "llm",
     credential: "llm-key",
   });
   ```

4. Use the route in `defineAgentDO`:

   ```ts
   export const AgentDO = defineAgentDO<Env>({
     bindings,
     llms: { default: chatRoute },
     tools: [],
     scopeRefForScope: (scope) => ({ kind: "conversation", scopeId: scope }),
   });
   ```

5. Store real values in Cloudflare bindings or local ignored `.dev.vars`.
   Report only `set` or `missing` in logs.

## Checkpoint

Ledger-visible payloads contain symbolic route and credential refs:

```text
endpoint: llm
credential: llm-key
model: gpt-4.1-mini
```

They must not contain raw URLs, provider tokens, account IDs, or resolved
provider response bodies.

## Next

Install the same surface from npm with [internal npm consumer app](internal-npm-consumer-app.md).
