import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { LedgerEventRpc } from "@agent-os/kernel/types";
import type { AgentRuntimeClient } from "../src";
import { validateExtensionDeclarations } from "@agent-os/kernel/extensions";
import {
  EXTENSION_COMMAND_EVENT,
  EXTENSION_RESULT_EVENT,
  proofLivedClaim,
  type ExtensionTestDO,
} from "./test-worker";

interface TestEnv {
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
}

type ExtensionRpc = AgentRuntimeClient & { readonly alarm: () => Promise<void> };

interface ExtensionCommand {
  readonly op: string;
  readonly at?: number;
  readonly data: unknown;
}

interface ExtensionResultPayload {
  readonly op: string;
  readonly ok: boolean;
  readonly result?: { readonly id: number };
  readonly error?: {
    readonly _tag?: string;
    readonly event?: string;
    readonly capability?: string;
    readonly issue?: string;
  };
}

const testEnv = env as unknown as TestEnv;

const stubFor = (scope: string): DurableObjectStub<ExtensionTestDO> & ExtensionRpc =>
  testEnv.EXTENSION_DO.get(
    testEnv.EXTENSION_DO.idFromName(scope),
  ) as DurableObjectStub<ExtensionTestDO> & ExtensionRpc;

const runCommand = async (
  stub: ExtensionRpc,
  command: ExtensionCommand,
): Promise<{
  readonly events: ReadonlyArray<LedgerEventRpc>;
  readonly result: ExtensionResultPayload;
}> => {
  await stub.emitEvent({ event: EXTENSION_COMMAND_EVENT, data: command });
  const events = await stub.events();
  const resultEvent = [...events]
    .reverse()
    .find((event: LedgerEventRpc) => event.kind === EXTENSION_RESULT_EVENT);
  expect(resultEvent).toBeDefined();
  return {
    events,
    result: resultEvent!.payload as ExtensionResultPayload,
  };
};

const extensionFacts = (events: ReadonlyArray<LedgerEventRpc>): ReadonlyArray<LedgerEventRpc> =>
  events.filter((event) => event.kind.startsWith("image.") || event.kind.startsWith("proof."));

describe("extension capability P1", () => {
  it("rejects positive capability minting for prefix-only namespaces", async () => {
    const { events, result } = await runCommand(stubFor("extension-commit-image"), {
      op: "commitImageFact",
      data: { jobRef: "img-1" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.capability_rejected");
    expect(result.error?.event).toBe("*");
    expect(result.error?.capability).toBe("extension:@agent-os/image:boundary");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("rejects deferred positive capability minting for prefix-only namespaces", async () => {
    const { events, result } = await runCommand(stubFor("extension-time-image"), {
      op: "scheduleImageFact",
      at: Date.now() - 1,
      data: { jobRef: "img-2" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.capability_rejected");
    expect(result.error?.event).toBe("*");
    expect(result.error?.capability).toBe("extension:@agent-os/image:boundary");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("rejects extension capability commits outside the package prefix", async () => {
    const { events, result } = await runCommand(stubFor("extension-wrong-prefix"), {
      op: "commitWrongPrefix",
      data: { commitRef: "c1" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.capability_rejected");
    expect(result.error?.event).toBe("*");
    expect(result.error?.capability).toBe("extension:@agent-os/image:boundary");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("commits boundary-owned facts only through the boundary contract", async () => {
    const { events, result } = await runCommand(stubFor("extension-proof-ok"), {
      op: "commitProofFact",
      data: {
        proofRef: "proof:ok",
        claim: proofLivedClaim,
      },
    });

    expect(result.ok).toBe(true);
    const proof = events.find((event) => event.kind === "proof.recorded");
    expect(proof).toMatchObject({
      kind: "proof.recorded",
      payload: {
        proofRef: "proof:ok",
        claim: proofLivedClaim,
      },
    });
    expect(result.result?.id).toBe(proof?.id);
  });

  it("rejects boundary-owned facts outside the exact event vocabulary", async () => {
    const { events, result } = await runCommand(stubFor("extension-proof-vocabulary"), {
      op: "commitProofOther",
      data: {
        proofRef: "proof:bad-kind",
        claim: proofLivedClaim,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.boundary_commit_rejected");
    expect(result.error?.event).toBe("proof.other");
    expect(result.error?.issue).toBe("event_outside_vocabulary");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("rejects boundary-owned facts without the declared claim", async () => {
    const { events, result } = await runCommand(stubFor("extension-proof-missing-claim"), {
      op: "commitProofFact",
      data: { proofRef: "proof:missing-claim" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.boundary_commit_rejected");
    expect(result.error?.event).toBe("proof.recorded");
    expect(result.error?.issue).toBe("claim_missing");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("rejects boundary-owned facts with settlement anchors outside the contract", async () => {
    const { events, result } = await runCommand(stubFor("extension-proof-anchor-kind"), {
      op: "commitProofFact",
      data: {
        proofRef: "proof:bad-anchor",
        claim: {
          ...proofLivedClaim,
          anchorRef: {
            ...proofLivedClaim.anchorRef,
            anchorKind: "external_receipt",
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.boundary_commit_rejected");
    expect(result.error?.event).toBe("proof.recorded");
    expect(result.error?.issue).toBe("claim_settlement_invalid");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("rejects deferred boundary facts before they enter scheduler state", async () => {
    const stub = stubFor("extension-proof-time-invalid");
    const { events, result } = await runCommand(stub, {
      op: "scheduleProofFact",
      at: Date.now() - 1,
      data: { proofRef: "proof:defer-invalid" },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.boundary_commit_rejected");
    expect(result.error?.event).toBe("proof.recorded");
    expect(result.error?.issue).toBe("claim_missing");
    expect(extensionFacts(events)).toHaveLength(0);

    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { alarm: () => Promise<void> }).alarm();
    });
    expect(extensionFacts(await stub.events())).toHaveLength(0);
  });

  it("rejects positive capability minting for unregistered packages", async () => {
    const { events, result } = await runCommand(stubFor("extension-missing-package"), {
      op: "commitMissingExtension",
      data: { ok: false },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.capability_rejected");
    expect(result.error?.event).toBe("*");
    expect(result.error?.capability).toBe("extension:@agent-os/missing");
    expect(extensionFacts(events)).toHaveLength(0);
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
