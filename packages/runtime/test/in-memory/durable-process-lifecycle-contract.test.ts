import { Effect, ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import { DurableTriggerRegistry, TriggerPump, type AnyDurableTrigger } from "@agent-os/runtime";
import {
  createTestInMemoryBackendState,
  createTestInMemoryRuntimeBackend,
} from "./runtime-helper";
import {
  runDurableProcessLifecycleContract,
  type DurableProcessLifecycleDriver,
} from "../../../core/test/backend-protocol/contract/durable-process-lifecycle-contract";
import { runtimeEventIdentity, truthIdentity } from "./identity";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): DurableProcessLifecycleDriver => {
  const scope = "durable-process-lifecycle";
  const state = createTestInMemoryBackendState();
  const runtime = ManagedRuntime.make(
    createTestInMemoryRuntimeBackend({
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
      const event = await runtime.runPromise(
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
      return { id: event.id };
    },
    drainDue: async (now) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.drainDue(now));
    },
    cancel: async (triggerKind, intentEventId, reason) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.cancelTrigger({ triggerKind, intentEventId, reason }));
    },
    processes: () => runtime.runPromise(state.durableProcessLifecycle(runtimeEventIdentity(scope))),
    events: () => Promise.resolve(state.eventSnapshot(runtimeEventIdentity(scope))),
    dispose: () => runtime.dispose(),
  };
};

describe("in-memory durable process lifecycle", () => {
  runDurableProcessLifecycleContract("in-memory", makeDriver);
});
