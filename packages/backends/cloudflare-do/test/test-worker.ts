/**
 * Test worker entry — exposes two DO classes:
 *
 *   TestAgentDO  — raw DurableObject. Quota contract tests bypass
 *                  CloudflareAgentDO entirely and compose Layers manually inside
 *                  runInDurableObject(stub, (instance, state) => { ... })
 *                  so they can stub the AiBinding deterministically.
 *
 *   EmitTestDO   — extends CloudflareAgentDO. emitEvent contract tests exercise
 *                  the public surface directly (stub.emitEvent(...)) and
 *                  verify the reactive triad: now-write commits a ledger
 *                  row AND fires registered on() handlers in the same DO
 *                  invocation. The constructor wires one handler whose
 *                  side-effect is itself an emitEvent — proving handler →
 *                  handler chaining via the ledger.
 *
 *   DispatchTestDO — extends CloudflareAgentDO. dispatch contract tests use it
 *                    on both sender and receiver sides to validate
 *                    cross-scope delivery without app-level RPC.
 *
 *   StreamTestDO — extends CloudflareAgentDO. event-stream contract tests use it
 *                  to validate streamEvents, events(opts), and worker-layer
 *                  Last-Event-ID parsing.
 *
 * The fetch handler exists only to satisfy the Workers runtime
 * requirement that a worker has a default export.
 */

import { DurableObject } from "cloudflare:workers";
import {
  type CloudflareAgentEnv,
  type DispatchTargetNamespace,
  type DispatchTargetRegistry,
} from "../src";
import { CloudflareAgentDO } from "../src/agent-do";
import { boundaryPackage, defineBoundaryContract } from "@agent-os/kernel/boundary-contract";
import type { ExtensionDeclaration } from "@agent-os/kernel/extensions";
import { makePreClaim, settleLivedClaim } from "@agent-os/kernel/effect-claim";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";

export class TestAgentDO extends DurableObject {}

export class EmitTestDO extends CloudflareAgentDO<CloudflareAgentEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareAgentEnv) {
    super(ctx, env);
    // Chain validation: emitting "interview.answer" triggers a handler
    // that emits "interview.followup". The contract test asserts both
    // rows appear in the ledger after one external emitEvent call.
    this.on("interview.answer", (event) =>
      this.emitEvent({
        event: "interview.followup",
        data: { sourceId: event.id, sourcePayload: event.payload },
      }).then(() => undefined),
    );
  }
}

interface DispatchEnv extends CloudflareAgentEnv {
  readonly DISPATCH_DO: DurableObjectNamespace<DispatchTestDO>;
}

const DEAD_TARGET: DispatchTargetNamespace = {
  idFromName: (_name) => ({}) as DurableObjectId,
  get: (_id) => ({
    __agentosReceiveDispatch: () => Promise.reject("dead dispatch target"),
  }),
};

const dispatchBindingKey = (ref: string): string =>
  materialRefKey(
    bindingMaterialRef({
      provider: "cloudflare",
      bindingKind: "durable_object",
      ref,
    }),
  );

export class DispatchTestDO extends CloudflareAgentDO<DispatchEnv> {
  constructor(ctx: DurableObjectState, env: DispatchEnv) {
    super(ctx, env);
    this.on("dispatch.inbound.accepted", () =>
      this.emitEvent({
        event: "test.inbound_accepted_handler_fired",
        data: {},
      }).then(() => undefined),
    );
    this.on("dispatch.outbound.requested", () =>
      this.emitEvent({
        event: "test.outbound_requested_handler_fired",
        data: {},
      }).then(() => undefined),
    );
    this.on("test.delivered", (event) =>
      this.emitEvent({
        event: "test.followup",
        data: { sourceId: event.id, sourcePayload: event.payload },
      }).then(() => undefined),
    );
  }

  protected override provideDispatchTargets(): DispatchTargetRegistry {
    return {
      [dispatchBindingKey("peer")]: this.env.DISPATCH_DO,
      [dispatchBindingKey("dead")]: DEAD_TARGET,
    };
  }
}

export class StreamTestDO extends CloudflareAgentDO<CloudflareAgentEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareAgentEnv) {
    super(ctx, env);
    this.on("stream.slow", () => scheduler.wait(1_000));
  }
}

const proofBoundaryContract = defineBoundaryContract({
  packageId: "@agent-os/proof",
  kindPrefixes: ["proof."],
  roles: ["generator", "reader"],
  vocabulary: {
    RECORDED: "proof.recorded",
  },
  authorityContracts: [],
  materialRequirements: [],
  claimPayloadKey: "claim",
  claimPhases: {
    "proof.recorded": ["lived"],
  },
  proof: {
    anchorKinds: ["carrier_proof"],
    symbolicOnly: true,
  },
  projection: {
    derivedFromLedger: true,
    shadowState: false,
  },
});

const proofPreClaim = makePreClaim({
  operationRef: "proof:record",
  scopeRef: { kind: "conversation", scopeId: "extension-proof" },
  authorityRef: { authorityId: "proof.record", authorityClass: "effect" },
  originRef: { originId: "extension-test", originKind: "test" },
});

export const proofLivedClaim = settleLivedClaim(proofPreClaim, {
  anchorId: "proof:record",
  anchorKind: "carrier_proof",
  carrierRef: "proof",
});

export class ExtensionTestDO extends CloudflareAgentDO<CloudflareAgentEnv> {
  protected override registerExtensions(): ReadonlyArray<ExtensionDeclaration> {
    return [
      {
        packageId: "@agent-os/image",
        kindPrefixes: ["image."],
        version: "0.3.0",
      },
      boundaryPackage(proofBoundaryContract, "0.1.0"),
    ];
  }

  commitImageFact(data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/image").commit({
      event: "image.job.recorded",
      data,
    });
  }

  commitWrongPrefix(data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/image").commit({
      event: "git.commit.recorded",
      data,
    });
  }

  commitMissingExtension(data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/missing").commit({
      event: "missing.fact",
      data,
    });
  }

  scheduleImageFact(at: number, data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/image").time({
      at,
      event: "image.job.deferred",
      data,
    });
  }

  commitProofFact(data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/proof").commit({
      event: "proof.recorded",
      data,
    });
  }

  commitProofOther(data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/proof").commit({
      event: "proof.other",
      data,
    });
  }

  scheduleProofFact(at: number, data: unknown): Promise<{ id: number }> {
    return this.extensionCapability("@agent-os/proof").time({
      at,
      event: "proof.recorded",
      data,
    });
  }
}

interface WorkerEnv extends CloudflareAgentEnv {
  readonly STREAM_DO: DurableObjectNamespace<StreamTestDO>;
  readonly EXTENSION_DO: DurableObjectNamespace<ExtensionTestDO>;
}

const parseLastEventId = (value: string | null): number => {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export default {
  async fetch(req: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/stream\/([^/]+)$/);
    if (match !== null) {
      const scope = decodeURIComponent(match[1] ?? "");
      const stub = env.STREAM_DO.get(env.STREAM_DO.idFromName(scope));
      return stub.streamEvents({
        afterId: parseLastEventId(req.headers.get("Last-Event-ID")),
      });
    }
    return new Response("@agent-os/backend-cloudflare-do test worker (not for direct use)");
  },
};
