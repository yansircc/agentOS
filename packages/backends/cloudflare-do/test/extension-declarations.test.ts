import { describe, expect, it } from "@effect/vitest";
import { validateExtensionDeclarations, type EventNamespace } from "@agent-os/kernel/extensions";

const namespace = ({
  ownerId,
  sourcePackageName,
  kindPrefixes,
}: {
  readonly ownerId: string;
  readonly sourcePackageName: string;
  readonly kindPrefixes: ReadonlyArray<string>;
}): EventNamespace => ({
  ownerId,
  sourcePackageName,
  packageId: sourcePackageName,
  kindPrefixes,
  version: "0.1.0",
});

const BACKEND_PROTOCOL_OWNER_ID = "@agent-os/backend-protocol";
const RUNTIME_PROTOCOL_OWNER_ID = "@agent-os/runtime-protocol";

describe("extension declarations", () => {
  it("reports the source owner for core backend and runtime namespaces", () => {
    expect(
      validateExtensionDeclarations([
        namespace({
          ownerId: "@agent-os/proof",
          sourcePackageName: "@agent-os/proof-source",
          kindPrefixes: ["quota."],
        }),
      ]),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "agent_os.extension_capability_conflict",
        ownerId: "@agent-os/proof",
        kindPrefix: "quota.",
        claimedBy: BACKEND_PROTOCOL_OWNER_ID,
      },
    });

    expect(
      validateExtensionDeclarations([
        namespace({
          ownerId: "@agent-os/proof",
          sourcePackageName: "@agent-os/proof-source",
          kindPrefixes: ["runtime."],
        }),
      ]),
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

  it("rejects duplicate owner ids before claiming extension prefixes", () => {
    const validation = validateExtensionDeclarations([
      namespace({
        ownerId: "@agent-os/proof",
        sourcePackageName: "@agent-os/proof-source-a",
        kindPrefixes: ["git."],
      }),
      namespace({
        ownerId: "@agent-os/proof",
        sourcePackageName: "@agent-os/proof-source-b",
        kindPrefixes: ["deploy."],
      }),
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
