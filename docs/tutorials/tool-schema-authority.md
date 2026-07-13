# Tool Schema And Authority

## Goal

Declare a tool whose schema, authority requirements, and effect policy are
visible before runtime without copying host binding maps into product intent.

## What You Build

An authored `lookup_weather` tool that is effectful, so `compileProductPlan`
requires symbolic material, execution-domain, interaction, and receipt-policy
facts. `linkStaticTarget` derives the target manifest from that one declaration.

## Prerequisites

- [Usage surfaces](../usage-surfaces.md)
- [CLI package](../packages/cli.md)
- [Weather tool LLM loop](weather-tool-llm-loop.md)

## Steps

1. Select the tool in `agent/agent.json`:

   ```json
   {
     "agentId": "weather-agent",
     "kind": "chat",
     "tools": ["lookup_weather"]
   }
   ```

2. Declare the effect contract once in
   `agent/tools/lookup_weather.ts`. The default export remains the tool
   implementation whose `defineProductTool` input schema and admission logic
   form the runtime positive contract:

   ```ts
   import lookupWeather from "../../app/tools/lookup-weather";

   export const declaration = {
     effects: ["material", "network"],
     materialRefs: ["weather-api"],
     executionDomain: "weather-read",
     interaction: "approval",
     receiptPolicy: "external-receipt",
   };

   export default lookupWeather;
   ```

   Tool identity is `lookup_weather` because that is the path stem. There is no
   second authored tool id or binding ref.

3. Compile the product and link it to an explicit host:

   ```ts
   import { compileProductPlan, linkStaticTarget } from "@yansirplus/cli";

   const product = compileProductPlan({
     files: [
       {
         path: "agent/agent.json",
         kind: "json",
         value: {
           agentId: "weather-agent",
           kind: "chat",
           tools: ["lookup_weather"],
         },
       },
       {
         path: "agent/instructions.md",
         kind: "markdown",
         text: "Answer weather questions with the lookup tool.",
       },
       {
         path: "agent/tools/lookup_weather.ts",
         kind: "tool",
         declaration: {
           effects: ["material", "network"],
           materialRefs: ["weather-api"],
           executionDomain: "weather-read",
           interaction: "approval",
           receiptPolicy: "external-receipt",
         },
       },
     ],
   });

   if (!product.ok) throw new Error(JSON.stringify(product.issues));

   const linked = linkStaticTarget(product.value, {
     kind: "local",
     mode: "dev",
     cwd: "/workspace/weather-agent",
     env: {},
   });

   if (!linked.ok) throw new Error(JSON.stringify(linked.issues));
   ```

   A deployment host supplies the resolver for `weather-api`; the product plan
   carries only the symbolic requirement. Resolved credentials never enter the
   plan, generated manifest, provenance, or ledger.

## Checkpoint

Removing `interaction`, `executionDomain`, `materialRefs`, or `receiptPolicy`
from the effectful tool is a compiler error. The resulting `ProductPlan`
contains the model, `weather-api`, `weather-read`, and `approval` symbolic
requirements. The linker derives the manifest's material, execution-domain,
interaction, and tool binding entries from the plan and its tool asset. There
are no separately authored maps that can drift from the tool declaration.

## Next

Read the durable outcome with [projection reader](projection-reader.md).
