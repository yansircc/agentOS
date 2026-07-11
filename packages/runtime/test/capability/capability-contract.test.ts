import { describe, expect, it } from "vite-plus/test";
import { defineCapability, defineHost, nodeHost } from "../../src/capability";
import { workspaceOpCarrier } from "../../src/workspace-op-carrier";

describe("defineCapability", () => {
  it("enforces invariant: capabilityId matches carrier.ownerId", () => {
    expect(() =>
      defineCapability({
        capabilityId: "wrong-id",
        carrier: workspaceOpCarrier,
        install: () => ({}),
      }),
    ).toThrow(/does not match carrier.ownerId/);
  });

  it("creates a valid capability contract with correct properties", () => {
    const cap = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      carrier: workspaceOpCarrier,
      install: () => ({}),
    });
    expect(cap.capabilityId).toBe(workspaceOpCarrier.ownerId);
    expect(cap.version).toBe("1");
    expect(cap.sourcePackageName).toBe("@agent-os/runtime");
    expect(cap.carrier).toBe(workspaceOpCarrier);
  });

  it("keeps explicit capability versions for peer preflight", () => {
    const cap = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      version: "2",
      carrier: workspaceOpCarrier,
      install: () => ({}),
    });
    expect(cap.version).toBe("2");
  });
});

const compileTimeAuthoringContract = (): void => {
  defineCapability({
    capabilityId: workspaceOpCarrier.ownerId,
    carrier: workspaceOpCarrier,
    // @ts-expect-error capability installation is synchronous graph assembly
    install: async () => ({}),
  });

  defineHost({
    target: "async-host@1",
    provides: [],
    // @ts-expect-error host fact materialization is synchronous graph assembly
    materialize: async () => ({}),
  });
};

void compileTimeAuthoringContract;

describe("defineHost", () => {
  it("creates a valid host profile", () => {
    expect(nodeHost.target).toBe("node@1");
    expect(nodeHost.provides.has("fs.workspace")).toBe(false);
    expect(nodeHost.provides.has("durability.do")).toBe(false);
  });
});
