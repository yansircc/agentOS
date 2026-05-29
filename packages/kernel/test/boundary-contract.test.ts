import { describe, expect, it } from "vite-plus/test";

import {
  boundaryPackage,
  defineBoundaryContract,
  validateBoundaryContract,
} from "../src/boundary-contract";
import { materialRequirement } from "../src/material-ref";
import { defineSettlementContract } from "../src/settlement-contract";

describe("BoundaryContract", () => {
  const proofStore = materialRequirement({
    slot: "proof_store",
    kind: "binding",
    provider: "example",
  });
  const settlement = defineSettlementContract({
    settlementId: "@agent-os/example-carrier",
    anchorKinds: ["carrier_proof"],
    rejectionKinds: ["policy_denied"],
  });

  const contract = defineBoundaryContract({
    packageId: "@agent-os/example-carrier",
    kindPrefixes: ["example."],
    roles: ["generator", "reader"],
    vocabulary: {
      RECORDED: "example.recorded",
      FAILED: "example.failed",
    },
    authorityContracts: [
      {
        authorityRef: {
          authorityId: "@agent-os/example-carrier.record",
          authorityClass: "effect",
        },
        requiredMaterials: [proofStore],
      },
    ],
    materialRequirements: [proofStore],
    claimPayloadKey: "claim",
    claimPhases: {
      "example.recorded": ["lived"],
      "example.failed": ["rejected"],
    },
    settlement,
    projection: {
      derivedFromLedger: true,
      shadowState: false,
    },
  });

  it("declares extension ownership from the boundary contract", () => {
    expect(boundaryPackage(contract, "0.1.0")).toEqual({
      packageId: "@agent-os/example-carrier",
      kindPrefixes: ["example."],
      version: "0.1.0",
      boundaryContract: contract,
    });
  });

  it("accepts a complete boundary declaration", () => {
    expect(validateBoundaryContract(contract)).toEqual({
      ok: true,
      contract,
    });
  });

  it("rejects vocabulary outside the owned prefix", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        vocabulary: {
          RECORDED: "other.recorded",
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["vocabulary_outside_prefix", "claim_phases_invalid"],
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
        authorityContracts: [],
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
        authorityContracts: [],
        materialRequirements: [],
      }),
    ).toEqual({
      ok: true,
      contract: {
        ...contract,
        authorityContracts: [],
        materialRequirements: [],
      },
    });
  });

  it("allows request-time claim phases only as event-kind declarations", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        claimPhases: {
          "example.recorded": ["pre"],
          "example.failed": ["rejected"],
        },
      }),
    ).toEqual({
      ok: true,
      contract: {
        ...contract,
        claimPhases: {
          "example.recorded": ["pre"],
          "example.failed": ["rejected"],
        },
      },
    });
  });

  it("rejects mixed request-time and terminal phases on one event kind", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        claimPhases: {
          "example.recorded": ["pre", "lived"],
          "example.failed": ["rejected"],
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["claim_phases_invalid"],
    });
  });

  it("requires claim phases to cover the event vocabulary exactly", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        claimPhases: {
          "example.recorded": ["lived"],
          "other.failed": ["rejected"],
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["claim_phases_invalid"],
    });
  });

  it("requires claim-bearing settlement and ledger projections", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        claimPayloadKey: "payload",
        settlement: {
          settlementId: "",
          anchorKinds: ["not_anchor"],
          rejectionKinds: ["policy_denied"],
        },
        projection: {
          derivedFromLedger: true,
          shadowState: true,
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["claim_payload_key_invalid", "settlement_invalid", "projection_invalid"],
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
