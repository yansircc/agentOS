import { Effect, ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { createInMemoryBackendState, createInMemoryRuntimeBackend } from "../src";
import {
  runImgGenPressureContract,
  type ImgGenPressureDriver,
} from "../../protocol/test/contract/img-gen-pressure-contract";
import { DurableTriggerRegistry, TriggerPump, type AnyDurableTrigger } from "@agent-os/runtime";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): ImgGenPressureDriver => {
  const scope = "img-gen-pressure";
  const state = createInMemoryBackendState();
  const runtime = ManagedRuntime.make(
    createInMemoryRuntimeBackend({
      state,
      scope,
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
        state.commitTriggerIntent(scope, fireAt, registry, trigger.kind, (trigger) => ({
          ts: fireAt,
          kind: trigger.intentEventKind,
          scope,
          payload,
        })),
      );
    },
    drainDue: async (now) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.drainDue(now));
    },
    events: () => Promise.resolve(state.snapshot(scope)),
    dispose: () => runtime.dispose(),
  };
};

describe("in-memory img-gen pressure", () => {
  runImgGenPressureContract("in-memory", makeDriver);
});
