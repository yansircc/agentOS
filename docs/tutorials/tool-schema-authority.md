# Tool Schema And Authority

## Goal

Define a tool whose input schema, authority, and admitter are one contract.

## What You Build

A `lookup_weather` tool that validates args with Effect Schema, declares a
single authority class, and rejects unsupported cities before execution.

## Prerequisites

- [Usage surfaces](../usage-surfaces.md)
- [Kernel package](../packages/kernel.md)
- [Weather tool LLM loop](weather-tool-llm-loop.md)

## Steps

1. Define the tool args:

   ```ts
   import { Schema } from "effect";
   import { defineTool } from "@agent-os/kernel/tools";

   const WeatherArgs = Schema.Struct({
     city: Schema.String,
     unit: Schema.Literal("celsius", "fahrenheit"),
   });
   ```

2. Bind schema, authority, admission, and execution together:

   ```ts
   const lookupWeather = defineTool({
     name: "lookup_weather",
     description: "Return a deterministic tutorial weather reading.",
     args: WeatherArgs,
     authority: "weather.read",
     authorityId: "tool:lookup_weather",
     admit: ({ city }) =>
       city.length > 0
         ? { ok: true }
         : { ok: false, reason: "city_required", rejectionRef: "weather/city_required" },
     execute: ({ city, unit }) => ({
       city,
       unit,
       temperature: unit === "celsius" ? 22 : 72,
       condition: "sunny",
     }),
   });
   ```

3. Register the tool in the agent facade:

   ```ts
   export const AgentDO = defineAgentDO<Env>({
     bindings: [
       /* material bindings */
     ],
     llms: { default: chatRoute },
     tools: [lookupWeather],
     scopeRefForScope: (scope) => ({ kind: "conversation", scopeId: scope }),
   });
   ```

4. Keep the authority stable. If the tool starts writing data or spending
   budget, create a new authority class instead of overloading `weather.read`.

## Checkpoint

The tool contract has one authority and an admitter role:

```text
toolId: lookup_weather
effectAuthorityRef.authorityClass: weather.read
roles: generator, admitter
```

Invalid args fail before `execute`. Rejected authority is explicit; it is not a
hidden exception from the tool implementation.

## Next

Read the durable outcome with [projection reader](projection-reader.md).
