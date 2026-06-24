import { describe, expect, it } from "@effect/vitest";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/core/boundary-contract";
import * as runtimeProtocol from "../../src/runtime-protocol";
import {
  type AnyAgentCapabilityDefinition,
  capabilityIntent,
  capabilityMaterial,
  capabilityProjection,
} from "../../src/runtime-protocol";

interface SurfaceEditIntent {
  readonly ops: ReadonlyArray<{ readonly op: "replace"; readonly path: string }>;
}

interface CandidateIdentity {
  readonly surfaceRef: string;
}

interface CandidateState {
  readonly status: "candidate_lived" | "candidate_rejected";
}

interface WordpressGrant {
  readonly bearer: string;
  readonly snapshot: string;
}

const effectAuthorityRef = {
  authorityClass: "tool" as const,
  authorityId: "surface-edit",
};

const factOwnerRef = "@agent-os/test.surface-edit" as const;

const surfaceEditBoundary = defineBoundaryContract({
  ownerId: factOwnerRef,
  sourcePackageName: factOwnerRef,
  kindPrefixes: ["surface_edit."],
  roles: ["generator", "resolver"],
  events: {
    "surface_edit.intent.requested": {
      payloadSchema: {
        type: "object",
        properties: {
          ops: { type: "array", items: { type: "object", properties: {} } },
        },
        required: ["ops"],
      },
      claim: { key: "claim", phase: "pre" },
    },
  },
  effectAuthorityContracts: [],
  materialRequirements: [],
  settlement: {
    settlementId: "surface-edit",
    anchorKinds: ["ledger_event"],
    rejectionKinds: ["validation_failed"],
    indeterminateKinds: [],
  },
  projection: { derivedFromLedger: true, shadowState: false },
});

const surfaceEditPackage = boundaryPackage(surfaceEditBoundary, "0.1.0");

const surfaceEditCapability = {
  id: "zeroy.surface-edit",
  boundaryPackage: surfaceEditPackage,
  intents: {
    requestEdit: capabilityIntent<SurfaceEditIntent>()("surface_edit.intent.requested"),
  },
  projections: {
    candidate: capabilityProjection<CandidateIdentity, CandidateState>()("surface_edit.candidate", {
      effectAuthorityRef,
      factOwnerRef,
    }),
  },
  materials: {
    wp: capabilityMaterial<WordpressGrant>()("wp_token"),
  },
} satisfies AnyAgentCapabilityDefinition;

describe("AgentCapability handles", () => {
  it("keeps legacy capability declarations as inert manifest metadata", () => {
    expect(surfaceEditCapability.intents.requestEdit.kind).toBe("surface_edit.intent.requested");
    expect(surfaceEditCapability.projections.candidate.kind).toBe("surface_edit.candidate");
    expect(surfaceEditCapability.materials.wp.slot).toBe("wp_token");
    expect("toolIntents" in surfaceEditCapability).toBe(false);
    expect("resolvedMaterials" in surfaceEditCapability).toBe(false);
  });

  it("does not expose legacy capability assembly helpers or runtime handles", () => {
    expect("defineAgentCapability" in runtimeProtocol).toBe(false);
    expect("submitBindingsForAgentCapability" in runtimeProtocol).toBe(false);
    expect("createAgentCapabilityHandle" in runtimeProtocol).toBe(false);
    expect("assertAgentCapabilityRuntimeContext" in runtimeProtocol).toBe(false);
  });
});
