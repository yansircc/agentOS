import { describe, expect, it } from "@effect/vitest";

import {
  WORKSPACE_TOPOLOGY,
  providerResourceId,
  workspaceBindingRef,
  workspaceProviderResourceId,
  workspaceProviderResourceIdentity,
} from "../../src/runtime-protocol";

describe("workspace topology resource identities", () => {
  it("derives provider resource ids from deployment, workspace slot, topology, and scope", () => {
    const scopeRef = { kind: "session" as const, scopeId: "demo" };
    const topology = {
      kind: WORKSPACE_TOPOLOGY.PER_SCOPE,
      allocator: "workspace-per-scope-v1",
    };
    const resourceId = workspaceProviderResourceId({
      deploymentNamespace: "web-cursor-demo",
      workspaceBindingRef: workspaceBindingRef("Sandbox"),
      topology,
      scopeRef,
    });

    expect(resourceId).toBe(
      providerResourceId(
        "agentos-provider-resource:workspace:v1:web-cursor-demo:Sandbox:per_scope:workspace-per-scope-v1:session%3Ademo",
      ),
    );
    expect(resourceId).not.toBe(scopeRef.scopeId);
  });

  it("does not collapse different deployments, workspaces, topology allocators, or scopes", () => {
    const base = {
      deploymentNamespace: "deployment-a",
      workspaceBindingRef: workspaceBindingRef("Sandbox"),
      topology: { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator: "workspace-per-scope-v1" },
      scopeRef: { kind: "session" as const, scopeId: "demo" },
    };
    const baseline = workspaceProviderResourceId(base);

    expect(workspaceProviderResourceId({ ...base, deploymentNamespace: "deployment-b" })).not.toBe(
      baseline,
    );
    expect(
      workspaceProviderResourceId({
        ...base,
        workspaceBindingRef: workspaceBindingRef("OtherSandbox"),
      }),
    ).not.toBe(baseline);
    expect(
      workspaceProviderResourceId({
        ...base,
        topology: { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator: "other-allocator" },
      }),
    ).not.toBe(baseline);
    expect(
      workspaceProviderResourceId({
        ...base,
        scopeRef: { kind: "conversation" as const, scopeId: "demo" },
      }),
    ).not.toBe(baseline);
  });

  it("returns the full allocation identity for provider adapters", () => {
    const identity = workspaceProviderResourceIdentity({
      deploymentNamespace: "deployment",
      workspaceBindingRef: workspaceBindingRef("Sandbox"),
      topology: { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator: "workspace-per-scope-v1" },
      scopeRef: { kind: "session", scopeId: "demo" },
    });

    expect(identity).toMatchObject({
      deploymentNamespace: "deployment",
      workspaceBindingRef: "Sandbox",
      topology: { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator: "workspace-per-scope-v1" },
      scopeRef: { kind: "session", scopeId: "demo" },
    });
    expect(identity.providerResourceId).toContain("agentos-provider-resource:workspace:v1");
  });

  it("fails closed for empty resource identity components", () => {
    expect(() => workspaceBindingRef("")).toThrow(/WorkspaceBindingRef/);
    expect(() => providerResourceId("")).toThrow(/ProviderResourceId/);
    expect(() =>
      workspaceProviderResourceId({
        deploymentNamespace: "",
        workspaceBindingRef: workspaceBindingRef("Sandbox"),
        topology: { kind: WORKSPACE_TOPOLOGY.PER_SCOPE, allocator: "workspace-per-scope-v1" },
        scopeRef: { kind: "session", scopeId: "demo" },
      }),
    ).toThrow(/deploymentNamespace/);
  });
});
