# Internal npm Consumer App

## Goal

Consume agentOS as packed npm packages instead of source workspace paths.

## What You Build

A tiny downstream TypeScript app that installs packed public packages, then
typechecks a smoke import from the authoring surface.

## Prerequisites

- [Distribution boundary](../concepts/distribution-boundary.md)
- [Internal npm distribution](../distribution.md)
- [Consume internal npm packages](../guides/consume-internal-npm-packages.md)

## Steps

1. From the agentOS repo, build tarballs:

   ```sh
   pnpm run pack:internal
   ```

2. In a separate consumer app, install one packed package and its peers:

   ```sh
   npm install /path/to/dist/internal-npm/tarballs/yansirplus-cli-0.5.16.tgz effect@^4
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
   import { compileAgentTree } from "@yansirplus/cli";

   const result = compileAgentTree({
     files: [{ path: "agent/instructions.md", kind: "markdown", text: "Say hello." }],
   });

   if (!result.ok) throw new Error(JSON.stringify(result.issues));
   ```

5. Run:

   ```sh
   npm exec tsc -- -p tsconfig.json
   node smoke.mjs
   ```

   A minimal `smoke.mjs` can import the packed package at runtime:

   ```js
   const authoring = await import("@yansirplus/cli");

   if (typeof authoring.compileAgentTree !== "function") {
     throw new Error("agentOS packed consumer proof failed");
   }
   ```

## Checkpoint

The installed package manifest points at `dist`:

```text
main: ./dist/index.js
types: ./dist/index.d.ts
exports . -> ./dist/index.js
peerDependencies.effect: ^4
```

The consumer typecheck and smoke import pass without `workspace:`, `file:`,
`packages/*`, or package source imports.

## Next

Add read-only operations with [ops view](ops-view.md).
