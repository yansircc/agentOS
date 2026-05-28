# Boundary Contract

`BoundaryContract` is the package-level declaration for claim-bearing
extensions.

## Axes

```text
Vocabulary   owned event kind prefixes and event vocabulary
Authority    authority refs and per-authority material requirements
Material     top-level MaterialRequirement declarations
Proof        symbolic anchor kinds and proof vocabulary
Projection   derived-from-ledger reader contract
```

These axes must be independently checkable. Authority requirements must be
subsets of the top-level material axis.

## Invariants

- Event kinds stay inside the package-owned prefix.
- Claim-bearing payloads use the `claim` key.
- Claim phases are declared per event kind. Request-time `pre` events are not
  terminal events.
- Proofs are symbolic.
- Projections are derived from ledger facts and do not write shadow truth.
- Cleanup is proof vocabulary until release becomes an independent cross-package
  contract axis.

## Minimal Shape

```ts
import { defineBoundaryContract } from "@agent-os/core/boundary-contract";

export const boundary = defineBoundaryContract({
  packageId: "@agent-os/example",
  kindPrefixes: ["example."],
  roles: ["resolver", "reader"],
  vocabulary: {
    REQUESTED: "example.requested",
    RECORDED: "example.recorded",
    FAILED: "example.failed",
  },
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    "example.requested": ["pre"],
    "example.recorded": ["lived"],
    "example.failed": ["rejected"],
  },
  proof: { anchorKinds: ["carrier_proof"], symbolicOnly: true },
  projection: { derivedFromLedger: true, shadowState: false },
});
```

Use `validateBoundaryContract` in tests when adding or changing a boundary.
