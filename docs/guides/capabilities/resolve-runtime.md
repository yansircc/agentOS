# resolveRuntime

`resolveRuntime` assembles `CapabilityContract` installs into one preflighted runtime graph.

## Invariant

`invariant.resolve.single-assembly-point`: For `CapabilityContract` inputs, `resolveRuntime()` runs requirement checks before install, globally validates install outputs before backend construction, and does not expose backend state to capability install functions.

## Usage

```ts
import { resolveRuntime, nodeHost, workspaceOperations } from "@agent-os/runtime";
const runtime = await resolveRuntime(nodeHost, [workspaceOperations({ env: process.env })], {
  identity: "my-agent",
  config: {},
  secrets: {},
});
if (!runtime.ok) {
  throw new Error(JSON.stringify(runtime.diagnostics));
}
const { layer, bindings } = runtime.resolved;
```

## Preflight Passes

1.  **name_unique**: Ensures no duplicate capability IDs
2.  **host_fact**: Validates all required host facts are provided
3.  **peer_dag**: Validates peer dependencies exist with no circular references
4.  **config**: Validates required configuration values are present
5.  **secret**: Validates required secrets are present
6.  **self_diagnostic**: Runs capability self-checks
7.  **global_unique**: Ensures no naming collisions across all global namespaces (events/projections/tools/triggers)
    Failed preflight returns `{ ok: false, diagnostics }` before the backend layer is constructed or ledger facts are accepted.
