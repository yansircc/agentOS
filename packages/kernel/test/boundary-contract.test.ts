import { describe, expect, it } from "vite-plus/test";

import {
  type BoundaryContract,
  type BoundaryEventContract,
  boundaryPackage,
  defineBoundaryContract,
  validateBoundaryContract,
} from "../src/boundary-contract";
import type { BoundaryPackage } from "../src/extensions";
import type { Authored } from "../src";
import { materialRequirement } from "../src/material-ref";
import { defineSettlementContract } from "../src/settlement-contract";

const emptyPayload = {
  type: "object",
  properties: {},
  additionalProperties: false,
} satisfies BoundaryEventContract["payloadSchema"];

const recordedPayload = {
  type: "object",
  properties: {
    value: { type: "string" },
  },
  required: ["value"],
  additionalProperties: false,
} satisfies BoundaryEventContract["payloadSchema"];

describe("BoundaryContract", () => {
  const proofStore = materialRequirement({
    slot: "proof_store",
    kind: "binding",
    provider: "example",
  });
  const settlement = defineSettlementContract({
    settlementId: "@agent-os/example-carrier",
    anchorKinds: ["carrier_proof", "ledger_event"],
    rejectionKinds: ["policy_denied", "provider_rejected"],
    indeterminateKinds: ["provider_pending"],
  });

  const contract = defineBoundaryContract({
    packageId: "@agent-os/example-carrier",
    kindPrefixes: ["example."],
    roles: ["generator", "reader"],
    events: {
      "example.requested": {
        payloadSchema: emptyPayload,
        claim: { key: "claim", phase: "pre" },
      },
      "example.recorded": {
        payloadSchema: recordedPayload,
        claim: { key: "claim", phase: "lived", anchorKinds: ["carrier_proof"] },
      },
      "example.failed": {
        payloadSchema: emptyPayload,
        claim: { key: "claim", phase: "rejected", rejectionKinds: ["policy_denied"] },
      },
      "example.pending": {
        payloadSchema: emptyPayload,
        claim: {
          key: "claim",
          phase: "indeterminate",
          indeterminateKinds: ["provider_pending"],
        },
      },
      "example.noted": {
        payloadSchema: recordedPayload,
      },
    },
    effectAuthorityContracts: [
      {
        effectAuthorityRef: {
          authorityId: "@agent-os/example-carrier.record",
          authorityClass: "effect",
        },
        requiredMaterials: [proofStore],
      },
    ],
    materialRequirements: [proofStore],
    settlement,
    projection: {
      derivedFromLedger: true,
      shadowState: false,
    },
  });

  it("declares extension ownership from the boundary contract", () => {
    const authoredContract: Authored<typeof contract.value> = contract;
    expect(authoredContract.value.packageId).toBe("@agent-os/example-carrier");
    expect(Object.prototype.propertyIsEnumerable.call(contract, "value")).toBe(false);
    expect(boundaryPackage(contract, "0.1.0")).toEqual({
      packageId: "@agent-os/example-carrier",
      kindPrefixes: ["example."],
      version: "0.1.0",
      boundaryContract: contract,
    });
  });

  it("keeps boundary package construction sealed to the constructor", () => {
    // @ts-expect-error BoundaryPackage is intentionally opaque; callers must use boundaryPackage().
    const literal: BoundaryPackage = {
      packageId: "@agent-os/example-carrier",
      kindPrefixes: ["example."],
      version: "0.1.0",
      boundaryContract: contract as BoundaryContract,
    };
    expect(literal.packageId).toBe("@agent-os/example-carrier");
  });

  it("accepts a complete event-level boundary declaration", () => {
    expect(validateBoundaryContract(contract)).toEqual({
      ok: true,
      contract,
    });
  });

  it("rejects event vocabulary outside the owned prefix", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        events: {
          "other.recorded": {
            payloadSchema: recordedPayload,
            claim: { key: "claim", phase: "lived", anchorKinds: ["carrier_proof"] },
          },
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["event_outside_prefix"],
    });
  });

  it("rejects event claim keys that collide with payload schema properties", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        events: {
          "example.recorded": {
            payloadSchema: {
              type: "object",
              properties: {
                claim: { type: "string" },
              },
              additionalProperties: false,
            },
            claim: { key: "claim", phase: "lived", anchorKinds: ["carrier_proof"] },
          },
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["event_claim_key_collides_with_payload"],
    });
  });

  it("rejects roles outside the claim role algebra", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        roles: ["generator", "runtime"],
      }),
    ).toEqual({
      ok: false,
      issues: ["roles_invalid"],
    });
  });

  it("requires event-local terminal vocabulary to be covered by settlement vocabulary", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        events: {
          "example.recorded": {
            payloadSchema: recordedPayload,
            claim: { key: "claim", phase: "lived", anchorKinds: ["external_receipt"] },
          },
          "example.failed": {
            payloadSchema: emptyPayload,
            claim: { key: "claim", phase: "rejected", rejectionKinds: ["resource_denied"] },
          },
          "example.pending": {
            payloadSchema: emptyPayload,
            claim: {
              key: "claim",
              phase: "indeterminate",
              indeterminateKinds: ["reconcile_required"],
            },
          },
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["event_claim_outside_settlement"],
    });
  });

  it("requires authority material dependencies to be declared on the material axis", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        materialRequirements: [],
      }),
    ).toEqual({
      ok: false,
      issues: ["authority_material_outside_axis"],
    });
  });

  it("requires material-axis declarations to be bound to an authority", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        effectAuthorityContracts: [],
      }),
    ).toEqual({
      ok: false,
      issues: ["material_authority_unbound"],
    });
  });

  it("allows empty material requirements only as an explicit no-material contract", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        effectAuthorityContracts: [],
        materialRequirements: [],
      }),
    ).toEqual({
      ok: true,
      contract: {
        ...contract,
        effectAuthorityContracts: [],
        materialRequirements: [],
      },
    });
  });

  it("requires settlement and ledger projection declarations", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        settlement: {
          settlementId: "",
          anchorKinds: ["not_anchor"],
          rejectionKinds: ["policy_denied"],
          indeterminateKinds: [],
        },
        projection: {
          derivedFromLedger: true,
          shadowState: true,
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["settlement_invalid", "projection_invalid"],
    });
  });

  it("rejects the removed proof shape", () => {
    const withoutSettlement: Record<string, unknown> = { ...contract };
    delete withoutSettlement.settlement;

    expect(
      validateBoundaryContract({
        ...withoutSettlement,
        proof: {
          anchorKinds: ["carrier_proof"],
          symbolicOnly: true,
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["settlement_invalid"],
    });
  });
});
