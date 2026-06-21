# Client And Workspace Preset Host Boundary Freeze

This file is the source owner for the hidden workspace preset host and canonical
client boundary used by the client/workspace-host campaign. Implementation
tasks may cite this file; CST task text must not become a second contract
table.

## Axes

```text
stable axis: runtime-protocol Recorded facts and projections
change axis: app consumption moves from low-level backend/AG-UI glue to generated clients and framework bridges
invariant: client state is a projection sink plus a command surface; rendered pixels are product code.
```

## Package Roles

`@agent-os/runtime-protocol` owns the canonical client read-model vocabulary:
Recorded run events, projection DTOs, `ContinuationRef`, and `InputRequestRef`.
Client packages may store and expose those values, but they must not mint a
second run-event vocabulary.

`@agent-os/ag-ui` is a framework-neutral opt-in wire projection over the
canonical runtime-protocol vocabulary. It may project canonical values into
AG-UI frames and accept AG-UI-shaped external input at the boundary. It is not
the client state model.

`@agent-os/client` owns one transport-neutral state machine. It receives:

- `streamSource`, which may be a browser-direct stream or a server bridge;
- `rpcInvoker`, which invokes typed commands;
- optional clock/test hooks.

It exposes a framework-neutral store:

```ts
type AgentClientStore<State> = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): State;
};
```

It also exposes the generic typed command invoker. The core client must not
import React, Svelte, AG-UI framework adapters, or product UI packages.

`@agent-os/client-react` and `@agent-os/client-svelte` are the only framework
bindings. Each package is a reactivity bridge over the core store:

- React uses `useSyncExternalStore`.
- Svelte exposes `readable` stores.
- named hooks/readables are selectors over the same store.

They must not contain component source, pixel layout, timeline/file-review
vocabulary, runtime event decoding, or transport-specific logic.

`@agent-os/ag-ui-react` and `@agent-os/ag-ui-svelte` are retired by this
boundary. Useful bridge behavior moves into `@agent-os/client-react` and
`@agent-os/client-svelte`. There is no compatibility shim package.

`@agent-os/workspace-agent` owns the hidden workspace preset host mechanism:

- workspace file/state projections;
- scan/diff/emit helpers;
- standard workspace tool binding;
- generated mount and generated typed client contract;
- typed reconcile contract.

It does not own product reconcile policy, product UI, or product-specific RPC
semantics.

## Client State Machine

The client state machine is transport-neutral. Browser-direct HTTP/SSE,
WebSocket, and server-bridge integrations are injected implementations of the
same `streamSource` and `rpcInvoker` contracts. The state machine owns:

- replay cursor and by-index reconnect;
- lifecycle state derived from recorded events;
- input request and continuation reference rotation;
- rejection of stale `ContinuationRef` and `InputRequestRef` values;
- command invocation status for commands it starts.

The client must consume ledger-witnessed symbolic refs. It must not expose or
interpret naked continuation tokens as capabilities, must not persist shadow
continuation state, and must not infer validity from client-local state.

Concurrent submissions do not imply a client-side total order beyond the order
recorded by the runtime/projection stream.

## Workspace Surface Split

Workspace preset host public operations are split by generator.

Projection reads are replayable/read-model surfaces:

- workspace state;
- workspace files and file metadata;
- run stream / run events;
- input requests;
- agent info / manifest projection.

Commands use `rpcInvoker`:

- submit;
- resume input request;
- read live file bytes;
- reset;
- destroy;
- custom authored RPC.

`readFile` is a command because file bytes are live sandbox material at read
time, not a durable projection fact. Products may choose to project selected
file content later, but the workspace host must not do that by default.

## Generated Mount

The generated Workspace Durable Object may contain exactly:

```text
one driver mount
projection sink configuration[]
```

Generated route handlers, generated clients, stream endpoints, agent info
views, and framework bindings are projections from the manifest and mount
configuration. They must not be copied back into the manifest and must not
create a third runtime generator.

## Reconcile Contract

Product reconcile policy is authored code with a typed boundary:

```ts
defineReconcile({
  sandbox,
  projection,
  append,
});
```

`sandbox` is Live material and is never serialized, placed in a manifest, or
written to the ledger. `projection` is Recorded read-model input. `append` may
append only Recorded facts accepted by the owning runtime/carrier contract.

## Structural Guards

The implementation guard must be positive and structural:

- client and framework bridge packages may contain TypeScript source only;
- `.tsx`, JSX-bearing files, `.svelte`, CSS, and component assets are forbidden
  in client/framework bridge packages;
- hook/readable return types must be imported from runtime-protocol,
  workspace-agent projections, or AG-UI projector types;
- framework bridge packages must not define local UI-shaped read-model types;
- retired AG-UI framework packages must not remain in the public package
  surface after the collapse phase;
- generated Workspace DO code must match the one-driver-plus-sinks shape.

The guard must not use token blacklists such as `Timeline` or `FileViewer` as
acceptance logic. Names may be diagnostics only after the structural contract
has already accepted or rejected the package.

## Package Exit Criteria

The migration is complete when:

- no public `@agent-os/ag-ui-react` or `@agent-os/ag-ui-svelte` package remains;
- `@agent-os/client-react` and `@agent-os/client-svelte` are the only
  per-framework bindings;
- `@agent-os/client` passes the same state-machine suite with browser-direct and
  server-bridge transports;
- client-exposed events roundtrip exactly against runtime-protocol projection
  fields, with no UI reshaping;
- workspace-agent projection reads are reactive/replayable and commands are
  routed through generic typed invocation;
- the web-cursor spike deletes local EventSource/NDJSON glue, local workspace
  projection/observer/tool-binding boilerplate, and local framework component
  requirements from the framework path.
