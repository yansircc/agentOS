import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { LedgerEventRpc } from "@agent-os/runtime";
import { validateExtensionDeclarations } from "@agent-os/kernel/extensions";
import { proofLivedClaim, type ExtensionTestDO } from "./test-worker";

interface TestEnv {
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("extension capability P1", () => {
  it("rejects positive capability minting for prefix-only namespaces", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-commit-image"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; capability?: string } | undefined;
      try {
        await instance.commitImageFact({ jobRef: "img-1" });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; capability?: string };
      }
      expect(caught?._tag).toBe("agent_os.capability_rejected");
      expect(caught?.event).toBe("*");
      expect(caught?.capability).toBe("extension:@agent-os/image:boundary");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("rejects deferred positive capability minting for prefix-only namespaces", async () => {
    const stub = testEnv.EXTENSION_DO.get(testEnv.EXTENSION_DO.idFromName("extension-time-image"));

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; capability?: string } | undefined;
      try {
        await instance.scheduleImageFact(Date.now() - 1, { jobRef: "img-2" });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; capability?: string };
      }
      expect(caught?._tag).toBe("agent_os.capability_rejected");
      expect(caught?.event).toBe("*");
      expect(caught?.capability).toBe("extension:@agent-os/image:boundary");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("rejects extension capability commits outside the package prefix", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-wrong-prefix"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; capability?: string } | undefined;
      try {
        await instance.commitWrongPrefix({ commitRef: "c1" });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; capability?: string };
      }
      expect(caught?._tag).toBe("agent_os.capability_rejected");
      expect(caught?.event).toBe("*");
      expect(caught?.capability).toBe("extension:@agent-os/image:boundary");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("commits boundary-owned facts only through the boundary contract", async () => {
    const stub = testEnv.EXTENSION_DO.get(testEnv.EXTENSION_DO.idFromName("extension-proof-ok"));

    const result = await stub.commitProofFact({
      proofRef: "proof:ok",
      claim: proofLivedClaim,
    });
    expect(result.id).toBe(1);

    const events: LedgerEventRpc[] = await stub.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      kind: "proof.recorded",
      payload: {
        proofRef: "proof:ok",
        claim: proofLivedClaim,
      },
    });
  });

  it("rejects boundary-owned facts outside the exact event vocabulary", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-proof-vocabulary"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; issue?: string } | undefined;
      try {
        await instance.commitProofOther({
          proofRef: "proof:bad-kind",
          claim: proofLivedClaim,
        });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; issue?: string };
      }
      expect(caught?._tag).toBe("agent_os.boundary_commit_rejected");
      expect(caught?.event).toBe("proof.other");
      expect(caught?.issue).toBe("event_outside_vocabulary");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("rejects boundary-owned facts without the declared claim", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-proof-missing-claim"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; issue?: string } | undefined;
      try {
        await instance.commitProofFact({ proofRef: "proof:missing-claim" });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; issue?: string };
      }
      expect(caught?._tag).toBe("agent_os.boundary_commit_rejected");
      expect(caught?.event).toBe("proof.recorded");
      expect(caught?.issue).toBe("claim_missing");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("rejects boundary-owned facts with proof anchors outside the contract", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-proof-anchor-kind"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; issue?: string } | undefined;
      try {
        await instance.commitProofFact({
          proofRef: "proof:bad-anchor",
          claim: {
            ...proofLivedClaim,
            anchorRef: {
              ...proofLivedClaim.anchorRef,
              anchorKind: "external_receipt",
            },
          },
        });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; issue?: string };
      }
      expect(caught?._tag).toBe("agent_os.boundary_commit_rejected");
      expect(caught?.event).toBe("proof.recorded");
      expect(caught?.issue).toBe("claim_anchor_invalid");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("rejects deferred boundary facts before they enter scheduler state", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-proof-time-invalid"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; issue?: string } | undefined;
      try {
        await instance.scheduleProofFact(Date.now() - 1, { proofRef: "proof:defer-invalid" });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; issue?: string };
      }
      expect(caught?._tag).toBe("agent_os.boundary_commit_rejected");
      expect(caught?.event).toBe("proof.recorded");
      expect(caught?.issue).toBe("claim_missing");
    });

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

  it("rejects positive capability minting for unregistered packages", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-missing-package"),
    );

    await runInDurableObject(stub, async (instance) => {
      let caught: { _tag?: string; event?: string; capability?: string } | undefined;
      try {
        await instance.commitMissingExtension({ ok: false });
      } catch (e) {
        caught = e as { _tag?: string; event?: string; capability?: string };
      }
      expect(caught?._tag).toBe("agent_os.capability_rejected");
      expect(caught?.event).toBe("*");
      expect(caught?.capability).toBe("extension:@agent-os/missing");
    });
    await expect(stub.events()).resolves.toHaveLength(0);
  });

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
