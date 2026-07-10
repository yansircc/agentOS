import { describe, expect, it } from "@effect/vitest";
import { compileBoundaryContract, defineBoundaryContract } from "@agent-os/core/boundary-contract";
import * as runtimeProtocol from "../../src/runtime-protocol";
import {
  DYNAMIC_CAPABILITY_EVENT,
  DYNAMIC_CAPABILITY_SLOT,
  DYNAMIC_CAPABILITY_VISIBILITY,
  type AnyAgentCapabilityDefinition,
  type DynamicCapabilityContext,
  type DynamicCapabilityInstructionProjectionEntry,
  type DynamicCapabilityResolverProvenance,
  capabilityIntent,
  capabilityMaterial,
  capabilityProjection,
  dynamicCapabilitySlotsForEvent,
  mergeDynamicCapabilityProjection,
  parseDynamicCapabilityResolverResult,
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

const surfaceEditModule = compileBoundaryContract(surfaceEditBoundary, "0.1.0");

const surfaceEditCapability = {
  id: "zeroy.surface-edit",
  boundaryModule: surfaceEditModule,
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

describe("DynamicCapability contract", () => {
  const catalog = {
    tools: [
      { id: "read_file", bindingRef: "tool.read_file" },
      { id: "write_file", bindingRef: "tool.write_file" },
    ],
    skills: [{ id: "review", digest: "fnv1a32:review" }],
    instructions: [{ id: "tone", digest: "fnv1a32:tone" }],
  };

  const event = {
    name: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED,
    sourceEventId: 42,
    sessionRef: "session:1",
    turnRef: "turn:1",
  };

  const provenance = (
    resolverId: string,
    slot: keyof typeof DYNAMIC_CAPABILITY_SLOT,
  ): DynamicCapabilityResolverProvenance => ({
    resolverId,
    slot: DYNAMIC_CAPABILITY_SLOT[slot],
    eventName: DYNAMIC_CAPABILITY_EVENT.TURN_STARTED,
    status: "applied",
  });

  it("declares event-to-slot visibility boundaries", () => {
    expect(dynamicCapabilitySlotsForEvent(DYNAMIC_CAPABILITY_EVENT.SESSION_STARTED)).toEqual([
      "tools",
      "skills",
      "instructions",
    ]);
    expect(dynamicCapabilitySlotsForEvent(DYNAMIC_CAPABILITY_EVENT.TURN_STARTED)).toEqual([
      "tools",
      "skills",
      "instructions",
    ]);
    expect(dynamicCapabilitySlotsForEvent(DYNAMIC_CAPABILITY_EVENT.STEP_STARTED)).toEqual([
      "tools",
    ]);
  });

  it("parses select-from-compiled resolver output and rejects unknown structure", () => {
    expect(
      parseDynamicCapabilityResolverResult({
        tools: { allow: ["read_file"], deny: ["write_file"] },
        skills: { allow: ["review"] },
        instructions: { allow: ["tone"] },
      }),
    ).toEqual({
      ok: true,
      value: {
        tools: { allow: ["read_file"], deny: ["write_file"] },
        skills: { allow: ["review"] },
        instructions: { allow: ["tone"] },
      },
    });

    expect(
      parseDynamicCapabilityResolverResult({
        tools: { allow: ["read_file"], text: "free prompt" },
        prompts: { allow: ["tone"] },
        instructions: { allow: ["tone", 1] },
      }),
    ).toEqual({
      ok: false,
      issues: [
        { path: "/prompts", reason: "unknown_field" },
        { path: "/tools/text", reason: "unknown_field" },
        { path: "/instructions/allow/1", reason: "target_id_string_required" },
      ],
    });
  });

  it("merges resolver outputs deterministically with deny winning conflicts", () => {
    const projection = mergeDynamicCapabilityProjection({
      event,
      catalog,
      results: [
        {
          provenance: provenance("allow-tools", "TOOLS"),
          result: { tools: { allow: ["write_file"] } },
        },
        {
          provenance: provenance("allow-skills", "SKILLS"),
          result: { skills: { allow: ["review"] } },
        },
        {
          provenance: provenance("deny-tools", "TOOLS"),
          result: { tools: { deny: ["write_file"] } },
        },
        {
          provenance: provenance("allow-instructions", "INSTRUCTIONS"),
          result: { instructions: { allow: ["tone"] } },
        },
      ],
    });

    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error(JSON.stringify(projection.issues));
    expect(projection.value.tools).toEqual([
      {
        id: "read_file",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.BASELINE,
        provenance: [],
      },
      {
        id: "write_file",
        visible: false,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.DENIED,
        provenance: [provenance("allow-tools", "TOOLS"), provenance("deny-tools", "TOOLS")],
      },
    ]);
    expect(projection.value.skills).toEqual([
      {
        id: "review",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED,
        provenance: [provenance("allow-skills", "SKILLS")],
      },
    ]);
    expect(projection.value.instructions).toEqual([
      {
        id: "tone",
        digest: "fnv1a32:tone",
        visible: true,
        decision: DYNAMIC_CAPABILITY_VISIBILITY.ALLOWED,
        provenance: [provenance("allow-instructions", "INSTRUCTIONS")],
      },
    ]);
    expect(JSON.stringify(projection.value.instructions)).not.toContain("free prompt");
  });

  it("fails closed on resolver targets outside the compiled catalog", () => {
    expect(
      mergeDynamicCapabilityProjection({
        event,
        catalog,
        results: [
          {
            provenance: provenance("unknown", "TOOLS"),
            result: { tools: { allow: ["missing"] } },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          kind: "unknown_target",
          resolverId: "unknown",
          slot: "tools",
          targetId: "missing",
        },
      ],
    });
  });

  it("fails closed on cross-slot outputs and event-forbidden slots", () => {
    expect(
      mergeDynamicCapabilityProjection({
        event,
        catalog,
        results: [
          {
            provenance: provenance("cross", "TOOLS"),
            result: { skills: { allow: ["review"] } },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          kind: "cross_slot_output",
          resolverId: "cross",
          resolverSlot: "tools",
          outputSlot: "skills",
        },
      ],
    });

    expect(
      mergeDynamicCapabilityProjection({
        event: { name: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED, stepRef: "step:1" },
        catalog,
        results: [
          {
            provenance: {
              ...provenance("step-skill", "SKILLS"),
              eventName: DYNAMIC_CAPABILITY_EVENT.STEP_STARTED,
            },
            result: { skills: { allow: ["review"] } },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          kind: "event_slot_forbidden",
          resolverId: "step-skill",
          eventName: "step.started",
          slot: "skills",
        },
      ],
    });
  });

  it("keeps resolver context read-only and instruction projection artifact-only", () => {
    const context = undefined as unknown as DynamicCapabilityContext;
    const instruction = undefined as unknown as DynamicCapabilityInstructionProjectionEntry;

    const assertTypeErrors = () => {
      // @ts-expect-error DynamicCapabilityContext has no ledger writer.
      const commit = context.commit;
      // @ts-expect-error DynamicCapabilityContext has no provider lifecycle opener.
      const provider = context.openProvider;
      // @ts-expect-error DynamicCapabilityContext catalog arrays are readonly.
      context.catalog.tools.push({ id: "late_tool" });
      // @ts-expect-error DynamicCapabilityProjection carries instruction artifact refs, not text.
      const text = instruction.text;
      return [commit, provider, text];
    };

    expect(typeof assertTypeErrors).toBe("function");
  });
});
