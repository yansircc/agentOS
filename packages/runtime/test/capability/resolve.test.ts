import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { resolveRuntime, nodeHost, defineCapability, defineHost } from "../../src/capability";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  workspaceOpCarrier,
} from "../../src/workspace-op-carrier";
import { RUNTIME_DIAGNOSTIC_KIND } from "../../src/runtime-diagnostic-carrier";
import { inMemoryConversationTruthIdentity } from "../../src/in-memory/state-helpers";

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
