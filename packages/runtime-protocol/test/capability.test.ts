import { describe, expect, it } from "@effect/vitest";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import * as runtimeProtocol from "../src";
import {
  capabilityIntent,
  capabilityMaterial,
  capabilityProjection,
  defineAgentCapability,
  submitBindingsForAgentCapability,
} from "../src";

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
  packageId: factOwnerRef,
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

const surfaceEditCapability = defineAgentCapability({
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
});

describe("AgentCapability handles", () => {
  it("derives submit bindings from the capability declaration", () => {
    const materialRef = { kind: "credential" as const, ref: "wp-token", provider: "wordpress" };
    const bindings = submitBindingsForAgentCapability(surfaceEditCapability, {
      materials: { wp: materialRef },
    });

    expect(bindings.toolIntents).toEqual([
      {
        kind: "surface_edit.intent.requested",
        boundaryPackage: surfaceEditPackage,
      },
    ]);
    expect(bindings.materials).toEqual({ wp_token: materialRef });
    expect("resolvedMaterials" in bindings).toBe(false);
  });

  it("keeps material refs closed over declared material aliases", () => {
    submitBindingsForAgentCapability(surfaceEditCapability, {
      // @ts-expect-error declared capability material aliases must be bound.
      materials: {},
    });
  });

  it("does not expose runtime handles or resolved material from the protocol surface", () => {
    expect("createAgentCapabilityHandle" in runtimeProtocol).toBe(false);
    expect("assertAgentCapabilityRuntimeContext" in runtimeProtocol).toBe(false);
  });

  it("fails fast when an intent has no boundary package source", () => {
    const unbound = defineAgentCapability({
      id: "unbound",
      intents: {
        request: capabilityIntent<{ readonly ok: true }>()("unbound.requested"),
      },
    });

    expect(() => submitBindingsForAgentCapability(unbound, {})).toThrow(
      "intent request has no boundary package",
    );
  });
});
