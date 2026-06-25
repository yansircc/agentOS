# defineHost

`defineHost` defines runtime host profiles that declare facts provided by the execution environment.

## Invariant

`invariant.host.fact-owner`: Host profiles are the single source of truth for environment-provided facts. Capabilities may only require facts declared by host profiles, and materialized host facts enter capability code only through `CapabilityInstallContext.host`.

## Usage

```ts
import { WORKSPACE_OPERATION_HOST_FACT, defineHost } from "@agent-os/runtime";
export const customHost = defineHost({
  target: "custom-host@1",
  provides: ["storage.ledger", WORKSPACE_OPERATION_HOST_FACT],
  materialize: () => ({
    [WORKSPACE_OPERATION_HOST_FACT]: () => workspaceEnv,
  }),
});
```
