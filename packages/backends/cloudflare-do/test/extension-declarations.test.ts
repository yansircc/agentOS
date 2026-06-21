import { describe, expect, it } from "@effect/vitest";
import { validateExtensionDeclarations, type EventNamespace } from "@agent-os/kernel/extensions";

const namespace = (packageId: string, kindPrefixes: ReadonlyArray<string>): EventNamespace => ({
  ownerId: packageId,
  sourcePackageName: packageId,
  packageId,
  kindPrefixes,
  version: "0.1.0",
});

const BACKEND_PROTOCOL_OWNER_ID = "@agent-os/backend-protocol";
const RUNTIME_PROTOCOL_OWNER_ID = "@agent-os/runtime-protocol";

describe("extension declarations", () => {
  it("reports the source owner for core backend and runtime namespaces", () => {
    expect(validateExtensionDeclarations([namespace("@agent-os/proof", ["quota."])])).toMatchObject(
      {
        ok: false,
        error: {
          _tag: "agent_os.extension_capability_conflict",
          ownerId: "@agent-os/proof",
          kindPrefix: "quota.",
          claimedBy: BACKEND_PROTOCOL_OWNER_ID,
        },
      },
    );

    expect(
      validateExtensionDeclarations([namespace("@agent-os/proof", ["runtime."])]),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "agent_os.extension_capability_conflict",
        ownerId: "@agent-os/proof",
        kindPrefix: "runtime.",
        claimedBy: RUNTIME_PROTOCOL_OWNER_ID,
      },
    });
  });

  it("rejects duplicate package ids before claiming extension prefixes", () => {
    const validation = validateExtensionDeclarations([
      namespace("@agent-os/proof", ["git."]),
      namespace("@agent-os/proof", ["deploy."]),
    ]);

    expect(validation).toMatchObject({
      ok: false,
      error: {
        _tag: "agent_os.extension_capability_conflict",
        ownerId: "@agent-os/proof",
        kindPrefix: "*",
        claimedBy: "@agent-os/proof",
      },
    });
  });
});
