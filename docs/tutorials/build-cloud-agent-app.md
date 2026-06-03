# Build A Cloud Agent App

## Goal

Build the smallest Cloudflare Durable Object app that uses the agentOS facade,
symbolic LLM material, and one tool.

## What You Build

One Worker module exporting an `AgentDO` class and a `fetch` handler. The DO
uses `defineAgentDO`, one `echo` tool, one symbolic endpoint, one symbolic
credential, and one `openAIChat` route.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Durable truth](../concepts/durable-truth.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)
- [Usage surfaces](../usage-surfaces.md)

## Steps

1. Install the app-facing packages and peers:

   ```sh
   bun add @agent-os/backend-cloudflare-do @agent-os/kernel effect
   bun add -d typescript @cloudflare/workers-types
   ```

2. Define one tool:

   ```ts
   import { defineTool } from "@agent-os/kernel";
   import { Schema } from "effect";

   const echo = defineTool({
     name: "echo",
     description: "Return the supplied text.",
     args: Schema.Struct({ text: Schema.String }),
     authority: "tutorial.local",
     admit: "allow",
     execute: ({ text }) => ({ text }),
   });
   ```

3. Define the Durable Object facade:

   ```ts
   import {
     credential,
     defineAgentDO,
     endpoint,
     openAIChat,
     type CloudflareAgentEnv,
   } from "@agent-os/backend-cloudflare-do";

   interface MaterialEnv extends CloudflareAgentEnv {
     readonly OPENAI_BASE_URL: string;
     readonly OPENAI_API_KEY: string;
   }

   export const AgentDO = defineAgentDO<MaterialEnv>({
     bindings: [
       endpoint<MaterialEnv>("llm").from((env) => env.OPENAI_BASE_URL),
       credential<MaterialEnv>("llm-key", { provider: "openai", purpose: "chat" }).from(
         (env) => env.OPENAI_API_KEY,
       ),
     ],
     llms: {
       default: openAIChat({
         model: "gpt-4.1-mini",
         endpoint: "llm",
         credential: "llm-key",
       }),
     },
     tools: [echo],
     scopeRefForScope: (scope) => ({ kind: "conversation", scopeId: scope }),
   });
   ```

4. In the Worker `fetch` handler, choose a scope and call the DO stub:

   ```ts
   type AgentDOInstance = InstanceType<typeof AgentDO>;
   interface WorkerEnv extends MaterialEnv {
     readonly AGENT_DO: DurableObjectNamespace<AgentDOInstance>;
   }

   export default {
     async fetch(request: Request, env: WorkerEnv) {
       const id = env.AGENT_DO.idFromName("tutorial");
       const agent = env.AGENT_DO.get(id);
       return Response.json(
         await agent.submit({
           intent: "Echo hello",
           input: { text: "hello" },
           deliver: "tutorial.echo.ready",
         }),
       );
     },
   };
   ```

5. Add Cloudflare Durable Object binding and migration config before deploying.
   Keep provider URLs and secrets in environment bindings, not source code.

6. Run local checks before live deployment:

   ```sh
   bunx tsc -p tsconfig.json
   bun build src/worker.ts --target=browser --outdir dist --external cloudflare:workers
   ```

## Checkpoint

The app typechecks and bundles while importing only public package entrypoints.
This is a local proof. It does not prove a live Cloudflare deployment or a live
LLM call.

## Next

Add a tool-backed LLM loop with [weather tool LLM loop](weather-tool-llm-loop.md),
background work with [durable trigger cancellation](durable-trigger-cancel.md),
or live sessions with [output-only attached streams](output-only-attached-stream.md).
