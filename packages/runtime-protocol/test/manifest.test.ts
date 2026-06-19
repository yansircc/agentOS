import { describe, expect, it } from "@effect/vitest";
import type { AgentSchemaSpec } from "@agent-os/kernel/agent-schema";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import {
  capabilityIntent,
  defineAgentCapability,
  defineAgentBindings,
  defineAgentManifest,
  manifestScopeRef,
  manifestTruthIdentity,
  mountAgent,
  projectAgentManifest,
  AGENT_MANIFEST_PROJECTION_TARGETS,
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
      scope: { kind: "conversation", idSource: "extension", stableScopeId: "ext:review" },
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

  it("projects one manifest view for info, CLI, docs, and typed client consumers", () => {
    const manifest = defineAgentManifest({
      agentId: "agent.projection",
      version: "1.2.3",
      instructions: {
        path: "agent/instructions.md",
        digest: "sha256:projection",
      },
      scope: { kind: "conversation", idSource: "submit_scope" },
      effectAuthorityRef,
      handlers: ["tool_called", "user_message"] as const,
      llmRoutes: {
        zed: { bindingRef: "llm.zed" },
        default: { bindingRef: "llm.default" },
      },
      tools: {
        weather: {
          bindingRef: "tool.weather",
          executionDomain: "app-runtime",
          interaction: "never",
        },
        lookup: {
          bindingRef: "tool.lookup",
          executionDomain: "workspace",
          interaction: "approval",
          effects: ["network"],
          receiptPolicy: "required",
        },
      },
      executionDomains: {
        workspace: { bindingRef: "domain.workspace" },
      },
      interactions: {
        approval: { bindingRef: "interaction.approval" },
      },
      identityFacets: [
        { kind: "deployment", key: "worker", digest: "deploy-v1" },
        { kind: "adapter", key: "llm", digest: "adapter-v1" },
      ],
    });

    const projection = projectAgentManifest(manifest);

    expect(projection.schema).toBe("agentos.agent_manifest_projection.v1");
    expect(projection.targets).toEqual([...AGENT_MANIFEST_PROJECTION_TARGETS]);
    expect(projection.source).toEqual({
      kind: "AgentManifest",
      agentId: "agent.projection",
      version: "1.2.3",
    });
    expect(projection.agent).toMatchObject({
      agentId: "agent.projection",
      instructions: {
        path: "agent/instructions.md",
        digest: "sha256:projection",
      },
      identityFacets: [
        { kind: "deployment", key: "worker", digest: "deploy-v1" },
        { kind: "adapter", key: "llm", digest: "adapter-v1" },
      ],
    });
    expect(projection.bindings.llmRoutes.map((entry) => entry.id)).toEqual(["default", "zed"]);
    expect(projection.bindings.tools.map((entry) => entry.id)).toEqual(["lookup", "weather"]);
    expect(projection.bindings.executionDomains).toEqual([
      { id: "workspace", value: { bindingRef: "domain.workspace" } },
    ]);
    expect(projection.bindings.interactions).toEqual([
      { id: "approval", value: { bindingRef: "interaction.approval" } },
    ]);
    expect("typedClient" in manifest).toBe(false);
    expect("workerEntry" in manifest).toBe(false);
  });
});

describe("manifest-owned runtime identity", () => {
  it("derives scopeRef and truth identity from a manifest-sourced scope", () => {
    const manifest = defineAgentManifest({
      agentId: "agent.identity",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
    });
    expect(manifestScopeRef(manifest)).toEqual({ kind: "session", scopeId: "demo" });
    expect(manifestTruthIdentity(manifest)).toEqual({
      scopeRef: { kind: "session", scopeId: "demo" },
      effectAuthorityRef,
    });
    expect(manifestTruthIdentity(manifest).effectAuthorityRef).toBe(effectAuthorityRef);
  });

  it("fails closed when scope is not manifest-owned or lacks a stable id", () => {
    const submitScoped = defineAgentManifest({
      agentId: "agent.submit",
      scope: { kind: "conversation", idSource: "submit_scope" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
    });
    expect(() => manifestScopeRef(submitScoped)).toThrow(/not "manifest"/);

    const missingId = defineAgentManifest({
      agentId: "agent.missing",
      scope: { kind: "conversation", idSource: "manifest" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
    });
    expect(() => manifestScopeRef(missingId)).toThrow(/stableScopeId/);
  });

  it("folds replay-affecting identity facets into effectAuthorityRef.version", () => {
    const manifest = defineAgentManifest({
      agentId: "agent.identity.facets",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef: { ...effectAuthorityRef, version: "base.v1" },
      handlers: ["user_message"] as const,
      identityFacets: [
        { kind: "provider_strategy", key: "structured", digest: "strategy-v1" },
        { kind: "deployment", key: "worker", digest: "deploy-v1" },
        { kind: "codec", key: "aead", digest: "codec-v1" },
        { kind: "adapter", key: "llm", digest: "adapter-v1" },
      ],
    });

    expect(manifestTruthIdentity(manifest)).toEqual({
      scopeRef: { kind: "session", scopeId: "demo" },
      effectAuthorityRef: {
        authorityClass: "agent",
        authorityId: "manifest-test",
        version:
          "agent-manifest-identity-v1|base=some:base%2Ev1|facet=adapter:llm:adapter-v1|facet=codec:aead:codec-v1|facet=deployment:worker:deploy-v1|facet=provider_strategy:structured:strategy-v1",
      },
    });
  });

  it("makes identity facet order irrelevant and digest changes load-bearing", () => {
    const left = defineAgentManifest({
      agentId: "agent.identity.left",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      identityFacets: [
        { kind: "adapter", key: "llm", digest: "adapter-v1" },
        { kind: "deployment", key: "worker", digest: "deploy-v1" },
      ],
    });
    const right = defineAgentManifest({
      agentId: "agent.identity.right",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      identityFacets: [
        { kind: "deployment", key: "worker", digest: "deploy-v1" },
        { kind: "adapter", key: "llm", digest: "adapter-v1" },
      ],
    });
    const changed = defineAgentManifest({
      agentId: "agent.identity.changed",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      identityFacets: [
        { kind: "deployment", key: "worker", digest: "deploy-v2" },
        { kind: "adapter", key: "llm", digest: "adapter-v1" },
      ],
    });

    expect(manifestTruthIdentity(left).effectAuthorityRef).toEqual(
      manifestTruthIdentity(right).effectAuthorityRef,
    );
    expect(manifestTruthIdentity(left).effectAuthorityRef.version).not.toBe(
      manifestTruthIdentity(changed).effectAuthorityRef.version,
    );
  });

  it("consumes outputSchema.fingerprint as the schema identity facet", () => {
    const outputSchema = {
      fingerprint: "agent-schema-v1:sha256:output",
    } as AgentSchemaSpec;
    const manifest = defineAgentManifest({
      agentId: "agent.identity.schema",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      outputSchema,
    });

    expect(manifestTruthIdentity(manifest).effectAuthorityRef.version).toBe(
      "agent-manifest-identity-v1|base=none|facet=schema:output:agent-schema-v1%3Asha256%3Aoutput",
    );
  });

  it("fails closed on duplicate identity facet keys", () => {
    const manifest = defineAgentManifest({
      agentId: "agent.identity.duplicate",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      identityFacets: [
        { kind: "deployment", key: "worker", digest: "deploy-v1" },
        { kind: "deployment", key: "worker", digest: "deploy-v2" },
      ],
    });

    expect(() => manifestTruthIdentity(manifest)).toThrow(/duplicate identity facet/);
  });

  it("fails closed when explicit schema facets duplicate outputSchema ownership", () => {
    const manifest = defineAgentManifest({
      agentId: "agent.identity.schema-duplicate",
      scope: { kind: "session", idSource: "manifest", stableScopeId: "demo" },
      effectAuthorityRef,
      handlers: ["user_message"] as const,
      identityFacets: [{ kind: "schema", key: "output", digest: "manual-schema" }],
      outputSchema: { fingerprint: "agent-schema-v1:sha256:output" } as AgentSchemaSpec,
    });

    expect(() => manifestTruthIdentity(manifest)).toThrow(/duplicate identity facet schema:output/);
  });
});
