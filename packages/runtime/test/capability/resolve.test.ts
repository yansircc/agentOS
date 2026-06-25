import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Schema } from "effect";
import { defineCarrier, event, none } from "@agent-os/core/carrier";
import { eventNamespace } from "@agent-os/core/extensions";
import { credentialMaterialRef } from "@agent-os/core/material-ref";
import { defineTool, deterministicToolExecution } from "@agent-os/core/tools";
import { LlmTransport, type LlmRoute } from "@agent-os/core/llm-protocol";
import {
  WORKSPACE_OPERATION_HOST_FACT,
  resolveRuntime,
  nodeHost,
  defineCapability,
  defineHost,
  workspaceOperations,
  type CapabilityContract,
  type CapabilityInstallation,
  type WorkspaceOperationEnvResolverInput,
} from "../../src/capability";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  workspaceOpCarrier,
} from "../../src/workspace-op-carrier";
import { RUNTIME_DIAGNOSTIC_KIND } from "../../src/runtime-diagnostic-carrier";
import { inMemoryConversationTruthIdentity } from "../../src/in-memory/state-helpers";
import type { AnyDurableTrigger } from "../../src/trigger";
import type { AnyMaterializedProjectionDefinition } from "../../src/projection";

const testCarrier = (ownerId: string, prefix: string) =>
  defineCarrier({
    ownerId,
    sourcePackageName: ownerId,
    prefix,
    roles: ["generator"],
    events: {
      requested: event({
        kind: "requested",
        payload: Schema.Struct({}),
        claim: none(),
      }),
    },
  });

const testCapability = (
  ownerId: string,
  prefix: string,
  overrides: Partial<{
    readonly version: string;
    readonly requires: CapabilityContract["requires"];
    readonly install: () => CapabilityInstallation | Promise<CapabilityInstallation>;
  }> = {},
): CapabilityContract =>
  defineCapability({
    capabilityId: ownerId,
    version: overrides.version,
    carrier: testCarrier(ownerId, prefix),
    requires: overrides.requires,
    install: overrides.install ?? (() => ({})),
  });

const testProjection = (kind: string): AnyMaterializedProjectionDefinition =>
  ({ kind }) as AnyMaterializedProjectionDefinition;

const testTrigger = (kind: string): AnyDurableTrigger => ({ kind }) as AnyDurableTrigger;

const testTool = (name: string) =>
  defineTool({
    name,
    description: "test tool",
    args: Schema.Struct({}),
    execute: () => Effect.succeed({ ok: true }),
    authority: "read",
    admit: () => Effect.succeed({ ok: true }),
    execution: deterministicToolExecution(),
  });

const testRoute = (modelId: string): LlmRoute =>
  ({
    kind: "openai-chat-compatible",
    endpointRef: `endpoint:${modelId}`,
    credentialRef: `credential:${modelId}`,
    modelId,
  }) as LlmRoute;

const expectGlobalUniqueFailure = async (
  capabilities: ReadonlyArray<CapabilityContract>,
  expectedReason: string,
) => {
  const result = await resolveRuntime(nodeHost, capabilities, { identity: expectedReason });
  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pass: "global_unique",
        reason: expect.stringContaining(expectedReason),
      }),
    ]),
  );
};

describe("resolveRuntime", () => {
  it("fails preflight when host fact is missing", async () => {
    // Node host does not provide durability.do, so requiring it should fail
    const testCapability = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      carrier: workspaceOpCarrier,
      requires: {
        hostFacts: ["durability.do"],
      },
      install: async () => ({}),
    });

    const result = await resolveRuntime(nodeHost, [testCapability], { identity: "test" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "host_fact",
          capabilityId: workspaceOpCarrier.ownerId,
          reason: expect.stringContaining("durability.do"),
        }),
      ]),
    );
  });

  it("fails preflight when capabilityId is duplicate", async () => {
    const cap1 = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      carrier: workspaceOpCarrier,
      install: async () => ({}),
    });
    const cap2 = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      carrier: workspaceOpCarrier,
      install: async () => ({}),
    });

    const result = await resolveRuntime(nodeHost, [cap1, cap2], { identity: "test" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "name_unique",
          capabilityId: workspaceOpCarrier.ownerId,
          reason: expect.stringContaining("Duplicate capabilityId"),
        }),
      ]),
    );
  });

  it("fails preflight when a required peer version does not match", async () => {
    const peer = testCapability("@agent-os/test.peer", "resolve.peer.");
    const consumer = testCapability("@agent-os/test.consumer", "resolve.consumer.", {
      requires: {
        peers: [{ capabilityId: peer.capabilityId, version: "2" }],
      },
    });

    const result = await resolveRuntime(nodeHost, [peer, consumer], { identity: "peer-version" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "peer_dag",
          capabilityId: consumer.capabilityId,
          reason: expect.stringContaining("version mismatch"),
          detail: expect.stringContaining('"installedVersion":"1"'),
        }),
      ]),
    );
  });

  it("fails preflight when a capability contract does not match its carrier owner", async () => {
    const valid = testCapability("@agent-os/test.malformed", "resolve.malformed.");
    const malformed = {
      ...valid,
      carrier: testCarrier("@agent-os/test.other-owner", "resolve.other-owner."),
    } as CapabilityContract;

    const result = await resolveRuntime(nodeHost, [malformed], { identity: "peer-owner" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "name_unique",
          capabilityId: valid.capabilityId,
          reason: expect.stringContaining("is not owned by carrier"),
        }),
      ]),
    );
  });

  it("returns structured diagnostics when capability install throws", async () => {
    const failing = testCapability("@agent-os/test.install-fails", "resolve.install-fails.", {
      install: () => {
        throw new Error("install boom");
      },
    });

    const result = await resolveRuntime(nodeHost, [failing], { identity: "install-fails" });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "install",
          capabilityId: failing.capabilityId,
          reason: expect.stringContaining("install failed"),
          detail: "install boom",
        }),
      ]),
    );
  });

  it("fails closed when diagnostic sink commit fails", async () => {
    const missingHostFact = testCapability("@agent-os/test.sink", "resolve.sink.", {
      requires: { hostFacts: ["durability.do"] },
    });

    const result = await resolveRuntime(nodeHost, [missingHostFact], {
      identity: "sink-fails",
      diagnosticSink: {
        commit: () => {
          throw new Error("sink down");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pass: "host_fact" }),
        expect.objectContaining({
          pass: "diagnostic_sink",
          reason: expect.stringContaining("fails closed"),
          detail: expect.stringContaining("sink down"),
        }),
      ]),
    );
  });

  it("fails preflight on duplicate event kinds", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.event-a", "resolve.duplicate-event."),
        testCapability("@agent-os/test.event-b", "resolve.duplicate-event."),
      ],
      "Duplicate event kind",
    );
  });

  it("fails preflight on duplicate projection kinds", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.projection-a", "resolve.projection-a.", {
          install: () => ({ projections: [testProjection("resolve.duplicate.projection")] }),
        }),
        testCapability("@agent-os/test.projection-b", "resolve.projection-b.", {
          install: () => ({ projections: [testProjection("resolve.duplicate.projection")] }),
        }),
      ],
      "Duplicate projection kind",
    );
  });

  it("fails preflight on duplicate trigger kinds", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.trigger-a", "resolve.trigger-a.", {
          install: () => ({ triggers: [testTrigger("resolve.duplicate.trigger")] }),
        }),
        testCapability("@agent-os/test.trigger-b", "resolve.trigger-b.", {
          install: () => ({ triggers: [testTrigger("resolve.duplicate.trigger")] }),
        }),
      ],
      "Duplicate trigger kind",
    );
  });

  it("fails preflight on duplicate tool names", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.tool-a", "resolve.tool-a.", {
          install: () => ({ bindings: { tools: { duplicate_tool: testTool("duplicate_tool") } } }),
        }),
        testCapability("@agent-os/test.tool-b", "resolve.tool-b.", {
          install: () => ({ bindings: { tools: { duplicate_tool: testTool("duplicate_tool") } } }),
        }),
      ],
      "Duplicate tool name",
    );
  });

  it("fails preflight on duplicate llm routes", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.route-a", "resolve.route-a.", {
          install: () => ({ bindings: { llmRoutes: { default: testRoute("a") } } }),
        }),
        testCapability("@agent-os/test.route-b", "resolve.route-b.", {
          install: () => ({ bindings: { llmRoutes: { default: testRoute("b") } } }),
        }),
      ],
      "Duplicate llm route",
    );
  });

  it("fails preflight on duplicate material bindings", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.material-a", "resolve.material-a.", {
          install: () => ({
            bindings: { materials: { token: credentialMaterialRef("token-a") } },
          }),
        }),
        testCapability("@agent-os/test.material-b", "resolve.material-b.", {
          install: () => ({
            bindings: { materials: { token: credentialMaterialRef("token-b") } },
          }),
        }),
      ],
      "Duplicate material",
    );
  });

  it("fails preflight on duplicate declared intents", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.intent-a", "resolve.intent-a.", {
          install: () => ({
            declaredIntents: [
              { kind: "resolve.duplicate.intent", boundaryOwnerId: "@agent-os/test.intent-a" },
            ],
          }),
        }),
        testCapability("@agent-os/test.intent-b", "resolve.intent-b.", {
          install: () => ({
            declaredIntents: [
              { kind: "resolve.duplicate.intent", boundaryOwnerId: "@agent-os/test.intent-b" },
            ],
          }),
        }),
      ],
      "Duplicate declared intent",
    );
  });

  it("fails preflight on overlapping extension prefixes", async () => {
    await expectGlobalUniqueFailure(
      [
        testCapability("@agent-os/test.extension-a", "resolve.extension-a.", {
          install: () => ({
            extensions: [
              eventNamespace({
                ownerId: "@agent-os/test.extension-a",
                sourcePackageName: "@agent-os/test.extension-a",
                kindPrefixes: ["resolve.extension."],
                version: "1",
              }),
            ],
          }),
        }),
        testCapability("@agent-os/test.extension-b", "resolve.extension-b.", {
          install: () => ({
            extensions: [
              eventNamespace({
                ownerId: "@agent-os/test.extension-b",
                sourcePackageName: "@agent-os/test.extension-b",
                kindPrefixes: ["resolve.extension.child."],
                version: "1",
              }),
            ],
          }),
        }),
      ],
      "Invalid extension namespace",
    );
  });

  it("resolves successfully with node host and workspace capabilities", async () => {
    const resolved = await resolveRuntime(nodeHost, [], {
      identity: "test-agent",
      llm: {},
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected resolveRuntime to succeed");
    expect(resolved.resolved.manifest.host).toBe("node@1");
    expect(resolved.resolved.layer).toBeDefined();
    expect(resolved.resolved.bindings).toBeDefined();
  });

  it("fails preflight when test fixture and provider transport both claim LLM assembly", async () => {
    const result = await resolveRuntime(nodeHost, [], {
      identity: "llm-source-conflict",
      llm: {},
      llmTransport: Layer.succeed(LlmTransport, {
        resolveRoute: () => Effect.die("unused"),
        call: () => Effect.die("unused"),
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.diagnostics).toEqual([
      expect.objectContaining({
        pass: "config",
        reason: expect.stringContaining("either test llm fixture options or llmTransport"),
      }),
    ]);
  });

  it("passes materialized host facts into capability install", async () => {
    const host = defineHost({
      target: "test@1",
      provides: [],
      materialize: () => ({ workspaceRoot: "/tmp/agentos-test" }),
    });
    let observedHostFact: unknown;
    const capability = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      carrier: workspaceOpCarrier,
      install: (ctx) => {
        observedHostFact = ctx.host.workspaceRoot;
        return {};
      },
    });

    const resolved = await resolveRuntime(host, [capability], { identity: "host-facts" });

    expect(resolved.ok).toBe(true);
    expect(observedHostFact).toBe("/tmp/agentos-test");
  });

  it("installs workspace operations from host-owned fs.workspace resolver", async () => {
    const resolverModes: string[] = [];
    const workspaceEnv = {
      domain: { kind: "sandbox" as const, ref: "workspace:host-owned" },
      cwd: "/workspace",
      resolvePath: (targetPath: string): string => targetPath,
      readFile: async () => "",
      readFileBuffer: async () => new Uint8Array(),
      writeFile: async () => undefined,
      stat: async () => ({ type: "file" as const }),
      readdir: async () => [],
      exists: async () => true,
      mkdir: async () => undefined,
      rm: async () => undefined,
      exec: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 0,
      }),
    };
    const host = defineHost({
      target: "workspace-host@1",
      provides: [WORKSPACE_OPERATION_HOST_FACT],
      materialize: () => ({
        [WORKSPACE_OPERATION_HOST_FACT]: (input: WorkspaceOperationEnvResolverInput) => {
          resolverModes.push(input.mode);
          return workspaceEnv;
        },
      }),
    });

    const resolved = await resolveRuntime(
      host,
      [workspaceOperations({ toolNames: ["read_file"] })],
      { identity: "workspace-host-owned", llm: {} },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("expected workspaceOperations to resolve");
    expect(resolverModes).toEqual(["binding"]);
    expect(resolved.resolved.bindings.tools?.read_file).toBeDefined();
  });

  it("records handler and projection ownership in the resolved install graph status", async () => {
    const capabilityId = "@agent-os/runtime-test.graph-owner";
    const projectionKind = "runtime.test.graph_projection";
    const handlerKind = "runtime.test.graph_event";
    const capability = testCapability(capabilityId, "graph_owner.", {
      install: () => ({
        projections: [testProjection(projectionKind)],
        eventHandlers: () => [
          {
            kind: handlerKind,
            handler: async () => undefined,
          },
        ],
      }),
    });

    const result = await resolveRuntime(nodeHost, [capability], { identity: "graph-status" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.installGraph.graphStatus.projection(projectionKind)).toEqual({
      status: "installed",
      kind: projectionKind,
      capabilityId,
    });
    expect(result.resolved.installGraph.graphStatus.handler(handlerKind)).toEqual({
      status: "installed",
      kind: handlerKind,
      capabilityId,
    });
    expect(result.resolved.installGraph.graphStatus.projection("runtime.test.absent")).toEqual({
      status: "missing",
      kind: "runtime.test.absent",
    });
  });

  it.effect("commits runtime diagnostic facts when resolved handlers fail", () =>
    Effect.gen(function* () {
      const failingCapability = defineCapability({
        capabilityId: workspaceOpCarrier.ownerId,
        carrier: workspaceOpCarrier,
        install: () => ({
          eventHandlers: () => [
            {
              kind: WORKSPACE_OP_KIND.REQUESTED,
              handler: async () => {
                throw new Error("boom");
              },
            },
          ],
        }),
      });

      const resolved = yield* Effect.promise(() =>
        resolveRuntime(nodeHost, [failingCapability], {
          identity: "diagnostic-agent",
          llm: {},
        }),
      );
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const identity = inMemoryConversationTruthIdentity("diagnostic-agent");
      yield* resolved.resolved.state.commitProtocolEvents([
        {
          kind: WORKSPACE_OP_KIND.REQUESTED,
          scopeRef: identity.scopeRef,
          effectAuthorityRef: identity.effectAuthorityRef,
          factOwnerRef: WORKSPACE_OP_FACT_OWNER,
          payload: { requestedBy: "test" },
        },
      ]);

      expect(
        resolved.resolved.state.snapshot(identity, {
          kinds: [RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED],
          factOwnerRefs: ["@agent-os/runtime-diagnostic"],
        }),
      ).toEqual([
        expect.objectContaining({
          kind: RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED,
          payload: expect.objectContaining({
            capabilityId: WORKSPACE_OP_FACT_OWNER,
            handler: WORKSPACE_OP_KIND.REQUESTED,
            reason: "boom",
            requestedEventId: 1,
          }),
        }),
      ]);
    }),
  );
});
