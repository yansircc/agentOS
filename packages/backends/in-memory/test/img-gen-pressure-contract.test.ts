import { ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { createInMemoryBackendState, createInMemoryRuntimeBackend } from "../src";
import {
  runImgGenPressureContract,
  type ImgGenPressureDriver,
} from "../../protocol/test/contract/img-gen-pressure-contract";
import { TriggerPump, type AnyDurableTrigger } from "@agent-os/runtime";

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
      const [event] = await runtime.runPromise(
        state.commitEvents([
          {
            ts: fireAt,
            kind: trigger.intentEventKind,
            scope,
            payload,
          },
        ]),
      );
      state.addDueWork(trigger.kind, event!.id, fireAt);
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
