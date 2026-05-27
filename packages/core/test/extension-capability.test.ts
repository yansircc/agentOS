import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { LedgerEventRpc } from "../src";
import { validateExtensionPackages } from "../src/extensions";
import type { ExtensionTestDO } from "./test-worker";

interface TestEnv {
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("extension capability P1", () => {
  it("commits package-owned facts through the minted extension capability", async () => {
    const stub = testEnv.EXTENSION_DO.get(
      testEnv.EXTENSION_DO.idFromName("extension-commit-image"),
    );

    const result = await stub.commitImageFact({ jobRef: "img-1" });
    expect(result.id).toBe(1);

    const events: LedgerEventRpc[] = await stub.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 1,
      kind: "image.job.recorded",
      payload: { jobRef: "img-1" },
    });
  });

  it("defers package-owned facts through extension time()", async () => {
    const stub = testEnv.EXTENSION_DO.get(testEnv.EXTENSION_DO.idFromName("extension-time-image"));

    const scheduled = await stub.scheduleImageFact(Date.now() - 1, {
      jobRef: "img-2",
    });
    expect(scheduled.id).toBe(1);
    await expect(stub.events()).resolves.toHaveLength(0);

    await runInDurableObject(stub, async (instance) => {
      await instance.alarm();
    });

    const events: LedgerEventRpc[] = await stub.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "image.job.deferred",
      payload: { jobRef: "img-2" },
    });
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
      expect(caught?.event).toBe("git.commit.recorded");
      expect(caught?.capability).toBe("extension:@agent-os/image");
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
    const validation = validateExtensionPackages([
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
