# Ops View

## Goal

Expose a read-only ops view over runtime projections without creating shadow
state.

## What You Build

An HTTP ops mount that lists scopes and reads one Durable Object's events, runs,
quota, and resources through `@agent-os/ops-api`.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Ops API package](../packages/ops-api.md)
- [Ops HTMX package](../packages/ops-htmx.md)

## Steps

1. Import the terminal ops adapter:

   ```ts
   import { mountOpsApi } from "@agent-os/ops-api";
   ```

2. Define a scope resolver. It owns routing from an ops scope string to a
   Durable Object namespace and name:

   ```ts
   const scopeResolver = {
     async list() {
       return [{ scope: "tutorial", label: "Tutorial", surface: "agent-do/v0.3" }];
     },
     async resolve(scope: string) {
       if (scope !== "tutorial") return null;
       return {
         scope,
         label: "Tutorial",
         surface: "agent-do/v0.3",
         namespace: env.AGENT_DO,
       };
     },
   };
   ```

3. Define auth at the edge:

   ```ts
   const auth = {
     async authenticate() {
       return { id: "local-dev", roles: ["operator"] };
     },
     async authorize(_principal, _scope, action) {
       return action === "read" || action === "stream";
     },
   };
   ```

4. Mount under an explicit path:

   ```ts
   const opsApi = mountOpsApi({ scopeResolver, auth });

   export default {
     fetch(request: Request) {
       if (new URL(request.url).pathname.startsWith("/__ops/api")) {
         return opsApi(request);
       }
       return appFetch(request);
     },
   };
   ```

## Checkpoint

The ops endpoint returns derived data only:

```text
GET /__ops/api/scopes
GET /__ops/api/scopes/tutorial/events
GET /__ops/api/scopes/tutorial/runs
```

Ops code does not write ledger facts and does not maintain its own run table.
If an ops view is wrong, fix the runtime projection or resolver boundary.

## Next

Deploy a Worker path with [deploy minimal worker](deploy-minimal-worker.md).
