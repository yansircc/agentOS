# defineCapability

`defineCapability` validates reusable `CapabilityContract` declarations before they enter the resolver path.

## Invariant

`invariant.capability.single-generator`: `CapabilityContract` installation facts are validated by `defineCapability()`: `capabilityId` must equal `carrier.ownerId`, `sourcePackageName` is derived from the carrier, `version` is the resolver-visible peer contract version, and install output is a synchronous description rather than backend state mutation. `install` must return `CapabilityInstallation` directly; asynchronous work belongs in installed runtime handlers, not graph assembly.

## Usage

```ts
import { defineCapability } from "@agent-os/runtime";
export const myCapability = defineCapability({
  capabilityId: "@your-org/my-capability",
  version: "1",
  carrier: myCarrier,
  requires: {
    hostFacts: ["fs.workspace"],
    peers: ["@agent-os/workspace-op"],
    config: [],
    secrets: [],
  },
  install: (ctx) => {
    return {
      projections: [],
      eventHandlers: () => [],
      bindings: {},
    };
  },
});
```
