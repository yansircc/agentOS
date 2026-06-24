# defineCapability

`defineCapability` validates reusable `CapabilityContract` declarations before they enter the resolver path.

## Invariant

`invariant.capability.single-generator`: `CapabilityContract` installation facts are validated by `defineCapability()`: `capabilityId` must equal `carrier.ownerId`, `sourcePackageName` is derived from the carrier, and install output is a description rather than backend state mutation.

## Usage

```ts
import { defineCapability } from "@agent-os/runtime";
export const myCapability = defineCapability({
  capabilityId: "@your-org/my-capability",
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
