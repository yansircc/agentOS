# Internal npm Consumer App

## Goal

Consume agentOS as packed npm packages instead of source workspace paths.

## What You Build

A tiny downstream TypeScript app that installs a packed `@agent-os/kernel`
tarball plus the explicit `effect` peer, then typechecks and runs a smoke
import.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Internal npm distribution](../distribution.md)
- [Consume internal npm packages](../guides/consume-internal-npm-packages.md)

## Steps

1. From the agentOS repo, build tarballs:

   ```sh
   bun run pack:internal
   ```

2. In a separate consumer app, install one packed package and its peer:

   ```sh
   npm install /path/to/dist/internal-npm/tarballs/agent-os-kernel-0.2.9.tgz effect@^3.21.0
   npm install -D typescript
   ```

3. Add a NodeNext `tsconfig.json`:

   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "NodeNext",
       "moduleResolution": "NodeNext",
       "strict": true,
       "skipLibCheck": true
     },
     "include": ["index.ts"]
   }
   ```

4. Import only package entrypoints:

   ```ts
   import { Effect } from "effect";
   import { ABORT, reasonOf } from "@agent-os/kernel";
   import { makePreClaim } from "@agent-os/kernel/effect-claim";

   const claim = makePreClaim({
     operationRef: "operation:tutorial",
     scopeRef: { kind: "session", scopeId: "session:tutorial" },
     authorityRef: { authorityId: "tutorial.proof", authorityClass: "effect" },
     originRef: { originId: "internal-npm-consumer", originKind: "tutorial" },
   });

   await Effect.runPromise(
     Effect.succeed({ reason: reasonOf(ABORT.TOOL_ERROR), phase: claim.phase }),
   );
   ```

5. Run:

   ```sh
   npm exec tsc -- -p tsconfig.json
   node smoke.mjs
   ```

   A minimal `smoke.mjs` can import the packed package at runtime:

   ```js
   const kernel = await import("@agent-os/kernel");

   if (kernel.reasonOf(kernel.ABORT.TOOL_ERROR) !== "tool_error") {
     throw new Error("agentOS packed consumer proof failed");
   }
   ```

## Checkpoint

The installed package manifest points at `dist`:

```text
main: ./dist/index.js
types: ./dist/index.d.ts
exports ./effect-claim -> ./dist/effect-claim.js
peerDependencies.effect: ^3.21.0
```

The consumer typecheck and smoke import pass without `workspace:`, `file:`,
`packages/*`, or `@agent-os/*/src` imports.

## Next

Add read-only operations with [ops view](ops-view.md).
