# Weather Tool LLM Loop

## Goal

Declare one weather tool and one model preference in product intent so the
generated runtime can call the tool before producing a final answer. The host,
not the product, binds that preference to a provider.

## What You Build

An authored `get_current_weather` tool whose identity comes from its path, plus
a backend-neutral `ProductPlan` that a local host can link and run.

## Prerequisites

- [Authoring minimal agent](cloudflare-do-minimal-app.md)
- [Usage surfaces](../usage-surfaces.md)
- [CLI package](../packages/cli.md)

## Steps

1. Select the tool and a logical model in `agent/agent.json`:

   ```json
   {
     "agentId": "weather-agent",
     "kind": "chat",
     "model": "default",
     "tools": ["get_current_weather"]
   }
   ```

2. Add `agent/tools/get_current_weather.ts`:

   ```ts
   import { defineProductTool } from "@yansirplus/core/tools";
   import { Effect, Schema } from "effect";

   export const declaration = {};

   export default defineProductTool({
     name: "get_current_weather",
     description: "Get the current weather for a city.",
     args: Schema.Struct({ city: Schema.String }),
     authority: "weather.read",
     admit: () => Effect.succeed({ ok: true as const }),
     execute: ({ city }) => Effect.succeed({ city, temperatureC: 21 }),
   });
   ```

   The deterministic result keeps this tutorial focused on the tool loop. The
   next tutorial replaces it with an effectful, material-backed lookup.

3. Compile the product once, then link the closed plan to a local host:

   ```ts
   import { compileProductPlan, linkStaticTarget } from "@yansirplus/cli";

   const compiled = compileProductPlan({
     files: [
       {
         path: "agent/instructions.md",
         kind: "markdown",
         text: "Use the weather tool before answering weather questions.",
       },
       {
         path: "agent/agent.json",
         kind: "json",
         value: {
           agentId: "weather-agent",
           kind: "chat",
           model: "default",
           tools: ["get_current_weather"],
         },
       },
       {
         path: "agent/tools/get_current_weather.ts",
         kind: "tool",
         declaration: {},
       },
     ],
   });

   if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));

   const linked = linkStaticTarget(compiled.value, {
     kind: "local",
     mode: "ask",
     cwd: "/workspace/weather-agent",
     env: {},
   });

   if (!linked.ok) throw new Error(JSON.stringify(linked.issues));
   ```

   `compileProductPlan` owns product semantics. `linkStaticTarget` adds the
   local node host, default provider route, scope, authority, and correlation
   boundary without recompiling the product.

4. Let the CLI perform the same local link and submit one turn:

   ```sh
   pnpm exec agentos ask "What is the weather in Lisbon?"
   ```

## Checkpoint

The `ProductPlan` contains product facts and symbolic requirements:

```text
agent.kind: chat
modelPreference: default
toolSelection: get_current_weather
assets.tools[0].path: agent/tools/get_current_weather.ts
symbolicRequirements: model
```

The linked manifest derives the tool binding and default route. Provider
credentials, host scope, and live route clients never enter product intent. The
ledger records runtime facts only after the generated driver runs.

## Next

Tighten the tool contract with [tool schema and authority](tool-schema-authority.md).
