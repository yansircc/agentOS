import { Effect, ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import {
  DurableTriggerRegistry,
  Ledger,
  TriggerPump,
  type AnyDurableTrigger,
} from "@agent-os/runtime";
import { commitDurableTriggerIntent } from "../src/due-work";
import { insertLedgerEvent } from "../src/ledger/inserted-events";
import { makeCloudflareBackendCoreLayer } from "../src/runtime-core";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import {
  runImgGenPressureContract,
  type ImgGenPressureDriver,
} from "../../protocol/test/contract/img-gen-pressure-contract";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): ImgGenPressureDriver => {
  const scope = "img-gen-pressure";
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
      await runtime.runPromise(
        commitDurableTriggerIntent(state, sql, fireAt, registry, trigger.kind, (trigger) =>
          insertLedgerEvent(sql, {
            ts: fireAt,
            kind: trigger.intentEventKind,
            scope,
            payloadStr: JSON.stringify(payload),
            payload,
          }),
        ),
      );
    },
    drainDue: async (now) => {
      const triggerPump = await runtime.runPromise(TriggerPump);
      await runtime.runPromise(triggerPump.drainDue(now));
    },
    events: async () => {
      const ledger = await runtime.runPromise(Ledger);
      return runtime.runPromise(ledger.events(scope));
    },
    dispose: () => runtime.dispose(),
  };
};

describe("cloudflare-do img-gen pressure", () => {
  runImgGenPressureContract("cloudflare-do", makeDriver);
});
