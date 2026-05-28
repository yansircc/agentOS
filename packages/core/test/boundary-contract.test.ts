import { describe, expect, it } from "vite-plus/test";

import {
  boundaryExtensionPackage,
  defineBoundaryContract,
  validateBoundaryContract,
} from "../src/boundary-contract";
import { materialRequirement } from "../src/material-ref";

describe("BoundaryContract", () => {
  const proofStore = materialRequirement({
    slot: "proof_store",
    kind: "binding",
    provider: "example",
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
    terminalClaims: ["lived", "rejected"],
    proof: {
      anchorKinds: ["carrier_proof"],
      symbolicOnly: true,
    },
    projection: {
      derivedFromLedger: true,
      shadowState: false,
    },
  });

  it("declares extension ownership from the boundary contract", () => {
    expect(boundaryExtensionPackage(contract, "0.1.0")).toEqual({
      packageId: "@agent-os/example-carrier",
      kindPrefixes: ["example."],
      version: "0.1.0",
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
      issues: ["vocabulary_outside_prefix"],
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

  it("requires claim-bearing symbolic ledger projections", () => {
    expect(
      validateBoundaryContract({
        ...contract,
        claimPayloadKey: "payload",
        proof: {
          anchorKinds: ["carrier_proof"],
          symbolicOnly: false,
        },
        projection: {
          derivedFromLedger: true,
          shadowState: true,
        },
      }),
    ).toEqual({
      ok: false,
      issues: ["claim_payload_key_invalid", "proof_invalid", "projection_invalid"],
    });
  });
});
