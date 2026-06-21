import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { LedgerEventRpc } from "@agent-os/core/types";
import type { BackendProtocolTruthIdentity } from "@agent-os/core/backend-protocol";
import {
  EXTENSION_COMMAND_EVENT,
  EXTENSION_RESULT_EVENT,
  proofLivedClaimForScope,
  type ExtensionTestDO,
} from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
}

interface ExtensionRpc {
  readonly emitEvent: (spec: { readonly event: string; readonly data: unknown }) => Promise<{
    readonly id: number;
  }>;
  readonly events: (
    identity: BackendProtocolTruthIdentity,
  ) => Promise<ReadonlyArray<LedgerEventRpc>>;
  readonly alarm: () => Promise<void>;
}

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
  scope: string,
  command: ExtensionCommand,
): Promise<{
  readonly events: ReadonlyArray<LedgerEventRpc>;
  readonly result: ExtensionResultPayload;
}> => {
  const stub = stubFor(scope);
  await stub.emitEvent({ event: EXTENSION_COMMAND_EVENT, data: command });
  const events: ReadonlyArray<LedgerEventRpc> = await stub.events(testTruthIdentity(scope));
  const resultEvent = Array.from(events)
    .reverse()
    .find((event) => event.kind === EXTENSION_RESULT_EVENT);
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
    const { events, result } = await runCommand("extension-commit-image", {
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
    const { events, result } = await runCommand("extension-time-image", {
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
    const { events, result } = await runCommand("extension-wrong-prefix", {
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
    const scope = "extension-proof-ok";
    const proofLivedClaim = proofLivedClaimForScope(scope);
    const { result } = await runCommand(scope, {
      op: "commitProofFact",
      data: {
        proofRef: "proof:ok",
        claim: proofLivedClaim,
      },
    });

    expect(result.ok).toBe(true);
    const proofIdentity: BackendProtocolTruthIdentity = {
      scopeRef: proofLivedClaim.scopeRef,
      effectAuthorityRef: proofLivedClaim.effectAuthorityRef,
    };
    const proofEvents: ReadonlyArray<LedgerEventRpc> = await stubFor(scope).events(proofIdentity);
    const proof = proofEvents.find((event) => event.kind === "proof.recorded");
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
    const scope = "extension-proof-vocabulary";
    const { events, result } = await runCommand(scope, {
      op: "commitProofOther",
      data: {
        proofRef: "proof:bad-kind",
        claim: proofLivedClaimForScope(scope),
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.boundary_commit_rejected");
    expect(result.error?.event).toBe("proof.other");
    expect(result.error?.issue).toBe("event_outside_vocabulary");
    expect(extensionFacts(events)).toHaveLength(0);
  });

  it("rejects boundary-owned facts without the declared claim", async () => {
    const { events, result } = await runCommand("extension-proof-missing-claim", {
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
    const scope = "extension-proof-anchor-kind";
    const { events, result } = await runCommand(scope, {
      op: "commitProofFact",
      data: {
        proofRef: "proof:bad-anchor",
        claim: {
          ...proofLivedClaimForScope(scope),
          anchorRef: {
            ...proofLivedClaimForScope(scope).anchorRef,
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
    const { events, result } = await runCommand("extension-proof-time-invalid", {
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
    expect(
      extensionFacts(await stub.events(testTruthIdentity("extension-proof-time-invalid"))),
    ).toHaveLength(0);
  });

  it("rejects positive capability minting for unregistered packages", async () => {
    const { events, result } = await runCommand("extension-missing-package", {
      op: "commitMissingExtension",
      data: { ok: false },
    });

    expect(result.ok).toBe(false);
    expect(result.error?._tag).toBe("agent_os.capability_rejected");
    expect(result.error?.event).toBe("*");
    expect(result.error?.capability).toBe("extension:@agent-os/missing");
    expect(extensionFacts(events)).toHaveLength(0);
  });
});
