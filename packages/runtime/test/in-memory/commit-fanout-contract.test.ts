import { ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/core/material-ref";
import {
  DISPATCH_EVENT_KINDS,
  dispatchTargetDelivered,
  type DispatchReceiver,
} from "@agent-os/core/backend-protocol";
import { Dispatch, defineProjection, projectionFail, projectionIdentity } from "@agent-os/runtime";
import { createInMemoryBackendState, createInMemoryRuntimeBackend } from "../../src/in-memory";
import { truthIdentity } from "./identity";

const failingDispatchDeliveredProjection = defineProjection({
  kind: "dispatch.delivered.failure",
  version: 1,
  eventKinds: [DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED],
  identity: Schema.Struct({ key: Schema.String }),
  state: Schema.Struct({ key: Schema.String }),
  identityKey: (identity) => identity.key,
  identify: () => projectionIdentity({ key: "single" }),
  initial: () => ({ key: "single" }),
  reduce: () => projectionFail("projection rejected dispatch delivery"),
});

describe("in-memory backend commit/fanout contract", () => {
  it("does not publish dispatch delivery facts when projection commit fails", async () => {
    const state = createInMemoryBackendState();
    const bindingRef = bindingMaterialRef({
      provider: "test",
      bindingKind: "do",
      ref: "receiver",
    });
    const bindingKey = materialRefKey(bindingRef);
    const projections = [failingDispatchDeliveredProjection];

    const receiverRuntime = ManagedRuntime.make(
      createInMemoryRuntimeBackend({ state, identity: truthIdentity("receiver"), projections })
        .layer,
    );
    const receiver: DispatchReceiver = {
      __agentosReceiveDispatch: async (envelope) => {
        const dispatch = await receiverRuntime.runPromise(Dispatch);
        return receiverRuntime.runPromise(dispatch.receive(envelope));
      },
    };
    const senderRuntime = ManagedRuntime.make(
      createInMemoryRuntimeBackend({
        state,
        identity: truthIdentity("sender"),
        projections,
        dispatchTargets: {
          [bindingKey]: {
            deliver: (envelope) =>
              receiver.__agentosReceiveDispatch(envelope).then(dispatchTargetDelivered),
          },
        },
      }).layer,
    );

    try {
      const dispatch = await senderRuntime.runPromise(Dispatch);
      const exit = await senderRuntime.runPromiseExit(
        dispatch.dispatchToScope({
          target: {
            bindingRef,
            scopeRef: { kind: "conversation", scopeId: "receiver" },
            effectAuthorityRef: { authorityClass: "effect", authorityId: "receiver" },
          },
          event: "app.received",
          data: { ok: true },
          idempotencyKey: "projection-failure",
        }),
      );

      expect(exit._tag).toBe("Failure");
      const outbound = state
        .snapshot(truthIdentity("sender"))
        .find((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_REQUESTED);
      expect(outbound).toBeDefined();
      expect(
        state
          .snapshot(truthIdentity("sender"))
          .some((event) => event.kind === DISPATCH_EVENT_KINDS.OUTBOUND_DELIVERED),
      ).toBe(false);
    } finally {
      await senderRuntime.dispose();
      await receiverRuntime.dispose();
    }
  });
});
