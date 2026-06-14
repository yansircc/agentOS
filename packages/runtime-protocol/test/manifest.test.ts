import { describe, expect, it } from "@effect/vitest";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import {
  capabilityIntent,
  defineAgentCapability,
  defineAgentBindings,
  defineAgentManifest,
  mountAgent,
  validateAgentMount,
  type AgentBindings,
  type AgentManifest,
} from "../src";

const effectAuthorityRef = {
  authorityClass: "agent" as const,
  authorityId: "manifest-test",
};

const baseManifest = defineAgentManifest({
  agentId: "agent.manifest-test",
  version: "0.1.0",
  scope: { kind: "conversation", idSource: "submit_scope" },
  effectAuthorityRef,
  handlers: ["user_message", "tool_called"] as const,
  llmRoutes: {
    default: { bindingRef: "llm.default" },
  },
  tools: {
    lookup: { bindingRef: "tool.lookup" },
  },
});

const capability = defineAgentCapability({
  id: "runtime-protocol.test-capability",
  intents: {
    requested: capabilityIntent<{ readonly id: string }>()("runtime_protocol.requested", {
      boundaryPackage: boundaryPackage(
        defineBoundaryContract({
          packageId: "@agent-os/runtime-protocol.test-capability",
          kindPrefixes: ["runtime_protocol."],
          roles: ["generator"],
          events: {
            "runtime_protocol.requested": {
              payloadSchema: { type: "object", properties: {}, additionalProperties: true },
              claim: { key: "claim", phase: "pre" },
            },
          },
          effectAuthorityContracts: [],
          materialRequirements: [],
          settlement: {
            settlementId: "runtime-protocol.test-capability",
            anchorKinds: ["ledger_event"],
            rejectionKinds: ["validation_failed"],
          },
          projection: { derivedFromLedger: true, shadowState: false },
        }),
        "0.1.0",
      ),
    }),
  },
});

describe("AgentManifest mount algebra", () => {
  it("mounts a function-free manifest when bindings cover every declared handler", () => {
    const bindings = defineAgentBindings<(typeof baseManifest.handlers)[number]>({
      handlers: {
        user_message: () => ({ ok: true }),
        tool_called: () => ({ ok: true }),
      },
    });

    const mounted = mountAgent(baseManifest, bindings, { backend: "test" });

    expect(mounted.manifest).toBe(baseManifest);
    expect(mounted.bindings).toBe(bindings);
    expect(mounted.warnings).toEqual([]);
  });

  it("keeps handler coverage as a type-level requirement", () => {
    const missing: AgentBindings<(typeof baseManifest.handlers)[number]> = {
      // @ts-expect-error tool_called is declared by the manifest and must be bound.
      handlers: {
        user_message: () => ({ ok: true }),
      },
    };
    void missing;
  });

  it("treats missing declared bindings as hard errors and dead bindings as warnings", () => {
    const missing = validateAgentMount(baseManifest, {
      handlers: {
        user_message: () => ({ ok: true }),
      },
    } as unknown as AgentBindings<(typeof baseManifest.handlers)[number]>);

    expect(missing).toEqual({
      ok: false,
      issues: [{ kind: "missing_handler_binding", handlerKind: "tool_called" }],
      warnings: [],
    });

    const dead = validateAgentMount(
      defineAgentManifest({
        agentId: "agent.dead-binding",
        scope: { kind: "conversation", idSource: "submit_scope" },
        effectAuthorityRef,
        handlers: ["user_message"] as const,
      }),
      defineAgentBindings<"user_message">({
        handlers: {
          user_message: () => ({ ok: true }),
          tool_called: () => ({ ok: true }),
        },
      }),
    );

    expect(dead).toEqual({
      ok: true,
      warnings: [{ kind: "dead_handler_binding", handlerKind: "tool_called" }],
    });
  });

  it("treats missing declared capability bindings as hard errors and dead capabilities as warnings", () => {
    const manifest = defineAgentManifest({
      agentId: "agent.capability",
      scope: { kind: "conversation", idSource: "submit_scope" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      capabilities: {
        surfaceEdit: { bindingRef: "capability.surface-edit" },
      },
    });

    const missing = validateAgentMount(
      manifest,
      defineAgentBindings<"user_message">({
        handlers: { user_message: () => ({ ok: true }) },
      }),
    );

    expect(missing).toEqual({
      ok: false,
      issues: [
        {
          kind: "missing_capability_binding",
          capability: "surfaceEdit",
          bindingRef: "capability.surface-edit",
        },
      ],
      warnings: [],
    });

    const mounted = mountAgent(
      manifest,
      defineAgentBindings<"user_message">({
        handlers: { user_message: () => ({ ok: true }) },
        capabilities: { "capability.surface-edit": capability },
      }),
      { backend: "test" },
    );

    expect(mounted.warnings).toEqual([]);

    const dead = validateAgentMount(
      defineAgentManifest({
        agentId: "agent.dead-capability",
        scope: { kind: "conversation", idSource: "submit_scope" },
        effectAuthorityRef,
        handlers: ["user_message"] as const,
      }),
      defineAgentBindings<"user_message">({
        handlers: { user_message: () => ({ ok: true }) },
        capabilities: { "capability.surface-edit": capability },
      }),
    );

    expect(dead).toEqual({
      ok: true,
      warnings: [{ kind: "dead_capability_binding", bindingRef: "capability.surface-edit" }],
    });
  });

  it("keeps extension handler kinds closed by manifest extension declarations", () => {
    const extensionManifest = defineAgentManifest({
      agentId: "agent.extension",
      scope: { kind: "extension", idSource: "extension", stableScopeId: "ext:review" },
      effectAuthorityRef,
      handlers: ["review.comment_added"] as const,
      extensions: [{ extensionId: "review", handlerKinds: ["review.comment_added"] as const }],
    });

    expect(
      validateAgentMount(
        extensionManifest,
        defineAgentBindings<"review.comment_added">({
          handlers: { "review.comment_added": () => ({ ok: true }) },
        }),
      ),
    ).toEqual({ ok: true, warnings: [] });

    const unknown = validateAgentMount(
      {
        ...extensionManifest,
        handlers: ["review.comment_added", "review.comment_deleted"],
      } as AgentManifest<"review.comment_added" | "review.comment_deleted">,
      {
        handlers: {
          "review.comment_added": () => ({ ok: true }),
          "review.comment_deleted": () => ({ ok: true }),
        },
      },
    );
    expect(unknown).toEqual({
      ok: false,
      issues: [{ kind: "unknown_handler_kind", handlerKind: "review.comment_deleted" }],
      warnings: [],
    });

    const prefixMismatch = validateAgentMount(
      {
        ...extensionManifest,
        extensions: [{ extensionId: "review", handlerKinds: ["other.comment_added"] }],
      } as AgentManifest<"review.comment_added">,
      {
        handlers: { "review.comment_added": () => ({ ok: true }) },
      },
    );
    expect(prefixMismatch).toMatchObject({
      ok: false,
      issues: [
        {
          kind: "extension_handler_prefix_mismatch",
          extensionId: "review",
          handlerKind: "other.comment_added",
        },
        { kind: "unknown_handler_kind", handlerKind: "review.comment_added" },
      ],
    });
  });

  it("rejects function-valued fields in AgentManifest at mount time", () => {
    const manifestWithClosure = {
      ...baseManifest,
      llmRoutes: {
        default: {
          bindingRef: "llm.default",
          resolve: () => "host-specific-route",
        },
      },
    } as AgentManifest<(typeof baseManifest.handlers)[number]>;

    const validation = validateAgentMount(
      manifestWithClosure,
      defineAgentBindings<(typeof baseManifest.handlers)[number]>({
        handlers: {
          user_message: () => ({ ok: true }),
          tool_called: () => ({ ok: true }),
        },
      }),
    );

    expect(validation).toEqual({
      ok: false,
      issues: [{ kind: "function_in_manifest", path: "manifest.llmRoutes.default.resolve" }],
      warnings: [],
    });
  });
});
