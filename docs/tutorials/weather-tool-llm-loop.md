# Weather Tool LLM Loop

## Goal

Declare one weather tool and one LLM route in the authored tree so the generated
runtime can call the tool before producing a final answer.

## What You Build

An authored `get_current_weather` tool declaration with a symbolic binding ref
and a default LLM route ref.

## Prerequisites

- [Authoring minimal agent](cloudflare-do-minimal-app.md)
- [Usage surfaces](../usage-surfaces.md)
- [Agent authoring package](../packages/agent-authoring.md)

## Steps

1. Add a default LLM route to `agent/agent.json`:

   ```json
   {
     "handlers": ["user_message"],
     "llmRoutes": {
       "default": { "bindingRef": "llm.default" }
     }
   }
   ```

2. Add `agent/tools/get_current_weather.ts`:

   ```ts
   export const declaration = {
     bindingRef: "tool.get_current_weather",
   };
   ```

3. Compile the tree:

   ```ts
   const compiled = compileAgentTree({
     files: [
       { path: "agent/instructions.md", kind: "markdown", text: instructions },
       { path: "agent/agent.json", kind: "json", value: agentJson },
       {
         path: "agent/tools/get_current_weather.ts",
         kind: "tool",
         declaration: { bindingRef: "tool.get_current_weather" },
       },
     ],
   });
   ```

4. Mount the generated manifest and generated bindings through the backend
   adapter in the framework build output.

5. Submit a user turn through the generated client:

   ```ts
   await agent.submit({
     message: "What is the weather in Lisbon?",
   });
   ```

## Checkpoint

The manifest contains only symbolic refs:

```text
handlers: user_message
llmRoutes.default.bindingRef: llm.default
tools.get_current_weather.bindingRef: tool.get_current_weather
```

Tool implementation, provider credentials, and live route clients stay outside
the authored manifest. The ledger records runtime facts after the generated
driver runs.

## Next

Tighten the tool contract with [tool schema and authority](tool-schema-authority.md).
