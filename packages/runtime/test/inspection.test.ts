import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { defineCarrier, event, none } from "@agent-os/core/carrier";
import {
  WORKSPACE_OPERATION_HOST_FACT,
  defineCapability,
  defineHost,
  nodeHost,
  projectInspectionSnapshot,
  resolveRuntime,
  workspaceOperations,
  type CapabilityContract,
  type InspectionSnapshot,
  type WorkspaceOperationEnvResolverInput,
} from "../src";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
} from "../src/workspace-op-carrier";
import type { AnyMaterializedProjectionDefinition } from "../src/projection";

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
    readonly requires: CapabilityContract["requires"];
    readonly install: CapabilityContract["install"];
  }> = {},
): CapabilityContract =>
  defineCapability({
    capabilityId: ownerId,
    carrier: testCarrier(ownerId, prefix),
    requires: overrides.requires,
    install: overrides.install ?? (() => ({})),
  });

const testProjection = (kind: string): AnyMaterializedProjectionDefinition =>
  ({ kind }) as AnyMaterializedProjectionDefinition;

const workspaceEnv = {
  domain: { kind: "sandbox" as const, ref: "workspace:inspection" },
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

const assertInspectionSnapshotTypes = (snapshot: InspectionSnapshot): void => {
  if (snapshot.resolve.status !== "available") return;
  // @ts-expect-error graph registrations are stable arrays, not public lookup maps
  snapshot.resolve.graph.handlers.get("workspace_op.requested");
  // @ts-expect-error graph lookup helpers stay out of the inspection projection
  snapshot.resolve.graph.handler("workspace_op.requested");
};

void assertInspectionSnapshotTypes;

describe("InspectionSnapshot", () => {
  it("projects resolved runtime facts into a stable inspection snapshot", async () => {
    const host = defineHost({
      target: "node@1",
      provides: [WORKSPACE_OPERATION_HOST_FACT],
      materialize: () => ({
        [WORKSPACE_OPERATION_HOST_FACT]: (_input: WorkspaceOperationEnvResolverInput) =>
          workspaceEnv,
      }),
    });
    const workspaceCapability = workspaceOperations({
      toolNames: ["read_file", "write_file"],
      mutationPolicy: "receipt-backed",
      authority: "agentos.workspace.inspect",
      authorityId: "workspace-inspection",
    });
    const optionalNetworkCapability = testCapability(
      "@agent-os/runtime-test.optional-network",
      "inspection.optional_network.",
      {
        requires: {
          hostFacts: [{ fact: "network.outbound", optional: true }],
        },
      },
    );

    const result = await resolveRuntime(host, [workspaceCapability, optionalNetworkCapability], {
      identity: "inspection",
      llm: {},
    });

    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }

    const snapshot = projectInspectionSnapshot({
      resolved: result.resolved,
      host,
      capabilities: [workspaceCapability, optionalNetworkCapability],
    });

    expect(snapshot.compile).toEqual({
      status: "available",
      target: "node@1",
      manifest: {
        host: "node@1",
        capabilities: expect.arrayContaining([
          WORKSPACE_OP_FACT_OWNER,
          "@agent-os/runtime-test.optional-network",
        ]),
      },
    });
    expect(snapshot.resolve.status).toBe("available");
    if (snapshot.resolve.status !== "available") return;
    expect(snapshot.resolve.hostFacts).toEqual([
      {
        fact: "fs.workspace",
        status: "provided",
        requiredBy: [WORKSPACE_OP_FACT_OWNER],
        optionalFor: [],
      },
      {
        fact: "network.outbound",
        status: "missing",
        requiredBy: [],
        optionalFor: ["@agent-os/runtime-test.optional-network"],
      },
    ]);
    expect(snapshot.resolve.graph.handlers).toEqual(
      expect.arrayContaining([
        {
          kind: WORKSPACE_OP_KIND.REQUESTED,
          capabilityId: WORKSPACE_OP_FACT_OWNER,
        },
      ]),
    );
    expect(snapshot.resolve.graph.projections).toEqual(
      expect.arrayContaining([
        {
          kind: WORKSPACE_OP_PROJECTION_KIND,
          capabilityId: WORKSPACE_OP_FACT_OWNER,
        },
      ]),
    );
    expect(snapshot.resolve.bindings.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "read_file",
          toolId: "read_file",
          authority: {
            authorityClass: "agentos.workspace.inspect",
            authorityId: "workspace-inspection",
          },
          receiptBackedIntentKinds: [],
        }),
        expect.objectContaining({
          name: "write_file",
          toolId: "write_file",
          authority: {
            authorityClass: "agentos.workspace.inspect",
            authorityId: "workspace-inspection",
          },
          receiptBackedIntentKinds: [WORKSPACE_OP_KIND.REQUESTED],
        }),
      ]),
    );
    expect(snapshot.resolve.bindings.receiptBackedTools).toEqual([
      {
        name: "write_file",
        kind: "intent_projection",
        intentKinds: [WORKSPACE_OP_KIND.REQUESTED],
      },
    ]);
    expect(snapshot.runtime).toEqual({
      status: "unavailable",
      reason: "runtime inspection was not requested",
    });
  });

  it("uses resolver-owned graph registrations instead of prefix ownership guesses", async () => {
    const capabilityId = "@agent-os/runtime-test.actual-owner";
    const handlerKind = "unrelated.prefix.event";
    const projectionKind = "another.owner.projection";
    const capability = testCapability(capabilityId, "inspection.actual_owner.", {
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

    const result = await resolveRuntime(nodeHost, [capability], {
      identity: "inspection-owner",
      llm: {},
    });

    if (!result.ok) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }

    const snapshot = projectInspectionSnapshot({
      resolved: result.resolved,
      host: nodeHost,
      capabilities: [capability],
    });

    expect(snapshot.resolve.status).toBe("available");
    if (snapshot.resolve.status !== "available") return;
    expect(snapshot.resolve.graph.handlers).toEqual(
      expect.arrayContaining([{ kind: handlerKind, capabilityId }]),
    );
    expect(snapshot.resolve.graph.projections).toEqual(
      expect.arrayContaining([{ kind: projectionKind, capabilityId }]),
    );
  });
});
