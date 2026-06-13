import { describe, expect, it } from "@effect/vitest";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import type { ToolExecutionContext, ToolProjectionWaitSpec } from "@agent-os/kernel/tools";
import { Effect } from "effect";
import {
  assertAgentCapabilityRuntimeContext,
  capabilityIntent,
  capabilityMaterial,
  capabilityProjection,
  createAgentCapabilityHandle,
  defineAgentCapability,
  submitBindingsForAgentCapability,
  type AgentCapabilityHandle,
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

  it.effect("derives intent and projection calls from the typed handle", () =>
    Effect.gen(function* () {
      const emitted: Array<{ readonly kind: string; readonly payload: unknown }> = [];
      const waited: unknown[] = [];
      const context: ToolExecutionContext = {
        materials: { wp_token: { bearer: "secret", snapshot: "snap-1" } },
        emitIntent: (kind, payload) => {
          emitted.push({ kind, payload });
          return Effect.succeed({ id: 42 });
        },
        awaitProjection: <State>(spec: ToolProjectionWaitSpec<State>) => {
          waited.push(spec);
          return Effect.succeed({
            kind: spec.kind,
            projectionKind: spec.kind,
            identityKey: JSON.stringify(spec.identity),
            state: { status: "candidate_lived" } as State,
            updatedEventId: 43,
          });
        },
      };
      const capabilityContext = assertAgentCapabilityRuntimeContext(surfaceEditCapability, context);
      const handle = createAgentCapabilityHandle(surfaceEditCapability, capabilityContext);

      const emittedResult = yield* handle.intents.requestEdit({
        ops: [{ op: "replace", path: "about.title" }],
      });
      const row = yield* handle.projections.candidate.await(
        { surfaceRef: "home" },
        { maxAttempts: 1 },
      );

      expect(emittedResult).toEqual({ id: 42 });
      expect(emitted).toEqual([
        {
          kind: "surface_edit.intent.requested",
          payload: { ops: [{ op: "replace", path: "about.title" }] },
        },
      ]);
      expect(waited).toEqual([
        {
          kind: "surface_edit.candidate",
          effectAuthorityRef,
          factOwnerRef,
          identity: { surfaceRef: "home" },
          maxAttempts: 1,
        },
      ]);
      expect(row.state).toEqual({ status: "candidate_lived" });
      expect(handle.materials.wp).toEqual({ bearer: "secret", snapshot: "snap-1" });
    }),
  );

  it("keeps handle calls closed over declared payload and identity types", () => {
    const compileOnly = (handle: AgentCapabilityHandle<typeof surfaceEditCapability>) => {
      const emitted = handle.intents.requestEdit({
        ops: [{ op: "replace", path: "about.title" }],
      });
      const projected = handle.projections.candidate.await({ surfaceRef: "home" });

      // @ts-expect-error intent payload is closed over the declared edit algebra.
      const wrongPayload = handle.intents.requestEdit("change the About page");
      // @ts-expect-error projection identity is closed over the declared identity algebra.
      const wrongIdentity = handle.projections.candidate.await({ page: "home" });

      void emitted;
      void projected;
      void wrongPayload;
      void wrongIdentity;
    };

    expect(compileOnly).toBeDefined();
  });

  it("fails fast when a declared runtime capability is absent", () => {
    expect(() =>
      assertAgentCapabilityRuntimeContext(surfaceEditCapability, {
        materials: { wp_token: { bearer: "secret", snapshot: "snap-1" } },
      }),
    ).toThrow("requires emitIntent");
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
