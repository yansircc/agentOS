# Boundary Contract

`BoundaryContract` is the package-level declaration for claim-bearing
extensions.

## Axes

```text
Vocabulary   owned event kind prefixes and event vocabulary
Authority    authority refs and per-authority material requirements
Material     top-level MaterialRequirement declarations
Settlement   terminal claim vocabulary and symbolic proof constraints
Projection   derived-from-ledger reader contract
```

These axes must be independently checkable. Authority requirements must be
subsets of the top-level material axis.

## Invariants

- Event kinds stay inside the package-owned prefix.
- Claim slots are event-local. Non-claim extension facts declare no claim slot.
- Request-time `pre` events are not terminal events.
- Terminal lived/rejected claims validate against the package settlement
  contract.
- Projections are derived from ledger facts and do not write shadow truth.
- Cleanup is settlement vocabulary until release becomes an independent
  cross-package contract axis.

## Minimal Shape

```ts
import { defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import { defineSettlementContract } from "@agent-os/kernel/settlement-contract";

const settlement = defineSettlementContract({
  settlementId: "@agent-os/example",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: ["provider_rejected"],
});

export const boundary = defineBoundaryContract({
  packageId: "@agent-os/example",
  kindPrefixes: ["example."],
  roles: ["resolver", "reader"],
  effectAuthorityContracts: [],
  materialRequirements: [],
  events: {
    "example.requested": {
      payloadSchema: {
        type: "object",
        properties: { subjectRef: { type: "string" } },
        required: ["subjectRef"],
        additionalProperties: false,
      },
      claim: { key: "claim", phase: "pre" },
    },
    "example.recorded": {
      payloadSchema: {
        type: "object",
        properties: { proofRef: { type: "string" } },
        required: ["proofRef"],
        additionalProperties: false,
      },
      claim: { key: "claim", phase: "lived", anchorKinds: ["carrier_proof"] },
    },
    "example.failed": {
      payloadSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      claim: { key: "claim", phase: "rejected", rejectionKinds: ["provider_rejected"] },
    },
  },
  settlement,
  projection: { derivedFromLedger: true, shadowState: false },
});
```

Use `validateBoundaryContract` in tests when adding or changing a boundary.
