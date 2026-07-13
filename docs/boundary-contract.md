# Boundary Contract

`BoundaryContract` is the package-level declaration for claim-bearing
extensions.

## Axes

```text
Vocabulary   owned event kind prefixes and event vocabulary
Authority    exact or runtime-bound trusted authority selectors
Material     top-level MaterialRequirement schemas referenced by authority slots
Settlement   terminal claim vocabulary and symbolic proof constraints
```

These axes must be independently checkable. Effect authority requirements must
reference slots from the top-level material axis. `factOwnerRef` is not part of
the authority axis; it comes from the boundary `ownerId`/explicit fact owner at
the commit boundary and cannot be set by claim authors.

## Invariants

- Event kinds stay inside the package-owned prefix.
- Claim slots are event-local. Non-claim extension facts declare no claim slot.
- Request-time `pre` events are not terminal events.
- Terminal lived/rejected claims validate against the package settlement
  contract.
- Every claim slot names one authority contract. An `exact` selector matches its
  authored `AuthorityRef`; a `bound` selector requires a trusted runtime binding
  supplied outside the claim.
- A claim-bearing boundary with an empty authority axis, a missing binding, or a
  mismatched contract ID or authority ref fails closed before ledger append.
- Every authority material slot is declared by the top-level material axis, and
  every declared material slot is referenced by an authority contract.
- Cleanup is settlement vocabulary until release becomes an independent
  cross-package contract axis.

Projection readers are a separate executable contract owned by
`MaterializedProjectionDefinition`. `BoundaryContract` does not duplicate a
reader kind, version, schema, event vocabulary, or reducer declaration.

## Minimal Shape

```ts
import { defineBoundaryContract } from "@agent-os/core/boundary-contract";
import { defineSettlementContract } from "@agent-os/core/settlement-contract";

const settlement = defineSettlementContract({
  settlementId: "@agent-os/example",
  anchorKinds: ["carrier_proof"],
  rejectionKinds: ["provider_rejected"],
});

const authorityContractId = "example.runtime";
const authorityRef = {
  authorityClass: "runtime",
  authorityId: "example",
} as const;

export const boundary = defineBoundaryContract({
  ownerId: "@agent-os/example",
  sourcePackageName: "@agent-os/runtime",
  kindPrefixes: ["example."],
  roles: ["resolver", "reader"],
  effectAuthorityContracts: [
    {
      authorityContractId,
      selector: { kind: "exact", authorityRef },
      requiredMaterialSlots: [],
    },
  ],
  materialRequirements: [],
  events: {
    "example.requested": {
      payloadSchema: {
        type: "object",
        properties: { subjectRef: { type: "string" } },
        required: ["subjectRef"],
        additionalProperties: false,
      },
      claim: { key: "claim", phase: "pre", authorityContractId },
    },
    "example.recorded": {
      payloadSchema: {
        type: "object",
        properties: { proofRef: { type: "string" } },
        required: ["proofRef"],
        additionalProperties: false,
      },
      claim: {
        key: "claim",
        phase: "lived",
        authorityContractId,
        anchorKinds: ["carrier_proof"],
      },
    },
    "example.failed": {
      payloadSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
        additionalProperties: false,
      },
      claim: {
        key: "claim",
        phase: "rejected",
        authorityContractId,
        rejectionKinds: ["provider_rejected"],
      },
    },
  },
  settlement,
});
```

Use `validateBoundaryContract` in tests when adding or changing a boundary.

## Compile For Installation

`BoundaryContract` is the only authored source. Compile it with an explicit
version before runtime installation:

```ts
import { compileBoundaryContract } from "@agent-os/core/boundary-contract";

export const boundaryModule = compileBoundaryContract(boundary, "1");
```

Compilation validates the four axes and returns an opaque `BoundaryModule`.
`module.contract` preserves the authored vocabulary, authority, material,
and settlement facts. `module.manifest` contains only the derived owner, source
package, kind prefixes, and version used by runtime installation.

`BoundaryModule` is not independently authored. Core compilation has no host,
backend, provider, filesystem, environment, time, or install-graph dependency;
runtime consumes the compiled module and installs its manifest. Agent docs and
the installed catalog continue to derive intent from `defineBoundaryContract`
declarations, not from compiled modules.
