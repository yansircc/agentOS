# Tool Schema And Authority

## Goal

Declare a tool whose authority and effect policy are visible before runtime.

## What You Build

An authored `lookup_weather` tool that is effectful, so the compiler requires
material, execution domain, interaction, and receipt policy declarations.

## Prerequisites

- [Usage surfaces](../usage-surfaces.md)
- [CLI package](../packages/cli.md)
- [Weather tool LLM loop](weather-tool-llm-loop.md)

## Steps

1. Add `agent/materials/weather-api.json`:

   ```json
   {
     "kind": "credential",
     "provider": "weather",
     "purpose": "read",
     "ref": "weather-api"
   }
   ```

2. Add `agent/domains/weather-read.json`:

   ```json
   {
     "bindingRef": "workspace.readonly"
   }
   ```

3. Add `agent/interactions/approval.json`:

   ```json
   {
     "bindingRef": "approval.required"
   }
   ```

4. Declare the effectful tool in `agent/tools/lookup_weather.ts`:

   ```ts
   export const declaration = {
     bindingRef: "tool.lookup_weather",
     effects: ["material", "network"],
     materialRefs: ["weather-api"],
     executionDomain: "weather-read",
     interaction: "approval",
     receiptPolicy: "external-receipt",
   };
   ```

5. Compile the tree and fail closed on missing facts:

   ```ts
   const result = compileAgentTree(tree);

   if (!result.ok) {
     throw new Error(JSON.stringify(result.issues));
   }
   ```

## Checkpoint

Removing `interaction`, `executionDomain`, `materialRefs`, or `receiptPolicy`
from the effectful tool is a compiler error. Pure tools may receive versioned
defaults with provenance; effectful tools do not get silent authority defaults.

## Next

Read the durable outcome with [projection reader](projection-reader.md).
