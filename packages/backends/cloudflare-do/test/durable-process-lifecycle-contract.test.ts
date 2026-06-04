import { Effect, ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import {
  DurableTriggerRegistry,
  Ledger,
  TriggerPump,
  type AnyDurableTrigger,
} from "@agent-os/runtime";
import { commitDurableTriggerIntent, selectDurableProcessLifecycle } from "../src/due-work";
import { EventBus } from "../src/ledger";
import { makeCloudflareBackendCoreLayer } from "../src/runtime-core";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import {
  runDurableProcessLifecycleContract,
  type DurableProcessLifecycleDriver,
} from "../../protocol/test/contract/durable-process-lifecycle-contract";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): DurableProcessLifecycleDriver => {
  const scope = "durable-process-lifecycle";
  const state = makeInMemoryDurableObjectState();
  const sql = state.storage.sql;
  const runtime = ManagedRuntime.make(
    makeCloudflareBackendCoreLayer(state, {}, scope, new Map(), {}, triggers),
  );

  return {
    enqueue: async (trigger, payload, fireAt) => {
      await runtime.runPromise(Ledger);
      await runtime.runPromise(TriggerPump);
      const registry = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* DurableTriggerRegistry;
        }),
      );
      const bus = await runtime.runPromise(EventBus);
      const event = await runtime.runPromise(
        commitDurableTriggerIntent(state, sql, bus, fireAt, registry, trigger.kind, (tx, trigger) =>
          tx.append({
            ts: fireAt,
            kind: trigger.intentEventKind,
            scope,
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
    processes: () => runtime.runPromise(selectDurableProcessLifecycle(sql)),
    dispose: () => runtime.dispose(),
  };
};

describe("cloudflare-do durable process lifecycle", () => {
  runDurableProcessLifecycleContract("cloudflare-do", makeDriver);
});
