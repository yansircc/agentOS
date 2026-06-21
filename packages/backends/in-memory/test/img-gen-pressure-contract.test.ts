import { Effect, ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { createInMemoryBackendState, createInMemoryRuntimeBackend } from "../src";
import {
  runImgGenPressureContract,
  type ImgGenPressureDriver,
} from "../../../core/test/backend-protocol/contract/img-gen-pressure-contract";
import { DurableTriggerRegistry, TriggerPump, type AnyDurableTrigger } from "@agent-os/runtime";
import { runtimeEventIdentity, truthIdentity } from "./identity";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): ImgGenPressureDriver => {
  const scope = "img-gen-pressure";
  const state = createInMemoryBackendState();
  const runtime = ManagedRuntime.make(
    createInMemoryRuntimeBackend({
      state,
      identity: truthIdentity(scope),
      triggers,
    }).layer,
  );

  return {
    enqueue: async (trigger, payload, fireAt) => {
      const registry = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* DurableTriggerRegistry;
        }),
      );
      await runtime.runPromise(
        state.commitTriggerIntent(
          runtimeEventIdentity(scope),
          fireAt,
          registry,
          trigger.kind,
          (trigger) => ({
            ts: fireAt,
            kind: trigger.intentEventKind,
            payload,
          }),
        ),
      );
    },
    drainDue: async (now) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.drainDue(now));
    },
    events: () => Promise.resolve(state.snapshot(truthIdentity(scope))),
    dispose: () => runtime.dispose(),
  };
};

describe("in-memory img-gen pressure", () => {
  runImgGenPressureContract("in-memory", makeDriver);
});
