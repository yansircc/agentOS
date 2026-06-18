# Provider Material Binding

## Goal

Declare provider material symbolically without leaking resolved values into
authored files, manifests, projections, or ledger facts.

## What You Build

One authored material ref and one LLM route binding ref. The actual provider
endpoint and credential are resolved only by the backend adapter.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Usage surfaces](../usage-surfaces.md)
- [Authoring minimal agent](cloudflare-do-minimal-app.md)

## Steps

1. Add `agent/materials/openai-key.json`:

   ```json
   {
     "kind": "credential",
     "provider": "openai",
     "purpose": "chat",
     "ref": "openai-key"
   }
   ```

2. Add the default route to `agent/agent.json`:

   ```json
   {
     "llmRoutes": {
       "default": { "bindingRef": "llm.default" }
     }
   }
   ```

3. Let the framework backend adapter own live resolution:

   ```ts
   const materialResolver = {
     material: (ref) => resolveMaterialFromEnv(env, ref),
   };
   ```

4. Store real values in Cloudflare bindings or local ignored `.dev.vars`.
   Report only `set` or `missing` in logs.

## Checkpoint

Authored and ledger-visible payloads contain symbolic refs:

```text
materials.openai-key.ref: openai-key
llmRoutes.default.bindingRef: llm.default
```

They must not contain raw URLs, provider tokens, account IDs, resolved clients,
or provider response bodies.

## Next

Install the same surface from npm with [internal npm consumer app](internal-npm-consumer-app.md).
