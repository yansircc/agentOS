# Weather Tool LLM Loop

## Goal

Define one weather tool and let an LLM turn call it before producing a final
answer.

## What You Build

A Cloudflare agent facade with `get_current_weather`, one LLM route, and a
submit call that returns a tool-informed answer.

## Prerequisites

- [Hello ledger event](hello-ledger-event.md)
- [Usage surfaces](../usage-surfaces.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)

## Steps

1. Define the weather tool:

   ```ts
   import { defineTool } from "@agent-os/kernel/tools";
   import { Schema } from "effect";

   const getCurrentWeather = defineTool({
     name: "get_current_weather",
     description: "Get the current weather for a city.",
     args: Schema.Struct({ city: Schema.String }),
     authority: "weather.read",
     admit: () => ({ ok: true }),
     execute: ({ city }) => ({
       city,
       temperatureC: 22,
       condition: "sunny",
     }),
   });
   ```

2. Register the tool in the same `defineAgentDO` facade as the LLM route:

   ```ts
   export const AgentDO = defineAgentDO<Env>({
     bindings: [
       endpoint<Env>("llm").from((env) => env.LLM_ENDPOINT),
       credential<Env>("llm-key").from((env) => env.LLM_KEY),
     ],
     llms: {
       default: openAIChat({
         model: "gpt-4.1-mini",
         endpoint: "llm",
         credential: "llm-key",
       }),
     },
     tools: [getCurrentWeather],
     scopeRefForScope: (scope) => ({ kind: "conversation", scopeId: scope }),
   });
   ```

3. Submit a user turn through the facade:

   ```ts
   const result = await agent.submit({
     intent: "What is the weather in Lisbon?",
     input: {},
     deliver: "weather.answer.ready",
     budget: { maxTurns: 3 },
   });
   ```

4. Keep weather facts in the tool implementation. Do not put provider material,
   API keys, raw provider responses, or resolved endpoint URLs into ledger
   events.

## Checkpoint

The deterministic local proof for this tutorial used a fake LLM transport and
verified this sequence:

```text
request 1 includes get_current_weather
LLM returns get_current_weather({ city: "Lisbon" })
runtime executes the tool
request 2 includes the tool result
LLM returns "Lisbon is sunny and 22 C."
weather.answer.ready is delivered
```

A live provider checkpoint is a separate opt-in smoke: run it only after the
provider endpoint, credential, and model are declared from one source.

## Next

Tighten the tool contract with [tool schema and authority](tool-schema-authority.md).
