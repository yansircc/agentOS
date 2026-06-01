import { describe, expect, it } from "@effect/vitest";
import { validateExtensionDeclarations } from "@agent-os/kernel/extensions";

describe("extension declarations", () => {
  it("rejects duplicate package ids before claiming extension prefixes", () => {
    const validation = validateExtensionDeclarations([
      {
        packageId: "@agent-os/proof",
        kindPrefixes: ["git."],
        version: "0.1.0",
      },
      {
        packageId: "@agent-os/proof",
        kindPrefixes: ["deploy."],
        version: "0.1.0",
      },
    ]);

    expect(validation).toMatchObject({
      ok: false,
      error: {
        _tag: "agent_os.extension_capability_conflict",
        packageId: "@agent-os/proof",
        kindPrefix: "*",
        claimedBy: "@agent-os/proof",
      },
    });
  });
});
