import { describe, expect, it } from "vite-plus/test";
import { defineCapability, nodeHost } from "../../src/capability";
import { workspaceOpCarrier } from "../../src/workspace-op-carrier";

describe("defineCapability", () => {
  it("enforces invariant: capabilityId matches carrier.ownerId", () => {
    expect(() =>
      defineCapability({
        capabilityId: "wrong-id",
        carrier: workspaceOpCarrier,
        install: async () => ({}),
      }),
    ).toThrow(/does not match carrier.ownerId/);
  });

  it("creates a valid capability contract with correct properties", () => {
    const cap = defineCapability({
      capabilityId: workspaceOpCarrier.ownerId,
      carrier: workspaceOpCarrier,
      install: async () => ({}),
    });
    expect(cap.capabilityId).toBe(workspaceOpCarrier.ownerId);
    expect(cap.sourcePackageName).toBe("@agent-os/runtime");
    expect(cap.carrier).toBe(workspaceOpCarrier);
  });
});

describe("defineHost", () => {
  it("creates a valid host profile", () => {
    expect(nodeHost.target).toBe("node@1");
    expect(nodeHost.provides.has("fs.workspace")).toBe(true);
    expect(nodeHost.provides.has("durability.do")).toBe(false);
  });
});
