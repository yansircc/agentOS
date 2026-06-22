import { Effect, ManagedRuntime } from "effect";
import { describe } from "@effect/vitest";
import {
  DurableTriggerRegistry,
  Ledger,
  TriggerPump,
  type AnyDurableTrigger,
} from "@agent-os/runtime";
import { RUNTIME_FACT_OWNER } from "@agent-os/core/runtime-protocol";
import type { BackendProtocolEventIdentity } from "@agent-os/core/backend-protocol";
import {
  commitDurableTriggerIntent,
  selectDurableProcessLifecycle,
} from "../../src/cloudflare/due-work";
import { EventBus } from "../../src/cloudflare/ledger/event-bus";
import { makeCloudflareBackendCoreLayer } from "../../src/cloudflare/runtime-core";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";
import {
  runDurableProcessLifecycleContract,
  type DurableProcessLifecycleDriver,
} from "../../../core/test/backend-protocol/contract/durable-process-lifecycle-contract";

const makeDriver = (triggers: ReadonlyArray<AnyDurableTrigger>): DurableProcessLifecycleDriver => {
  const scope = "durable-process-lifecycle";
  const identity: BackendProtocolEventIdentity = {
    scopeRef: { kind: "conversation", scopeId: scope },
    effectAuthorityRef: { authorityClass: "effect", authorityId: scope },
    factOwnerRef: RUNTIME_FACT_OWNER,
  };
  const state = makeInMemoryDurableObjectState();
  const sql = state.storage.sql;
  const runtime = ManagedRuntime.make(
    makeCloudflareBackendCoreLayer(state, {}, scope, identity, new Map(), {}, triggers),
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
        commitDurableTriggerIntent(
          state,
          sql,
          bus,
          identity,
          fireAt,
          registry,
          trigger.kind,
          (tx, trigger) =>
            tx.append({
              ts: fireAt,
              kind: trigger.intentEventKind,
              scopeRef: identity.scopeRef,
              effectAuthorityRef: identity.effectAuthorityRef,
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
    events: async () => {
      const ledger = await runtime.runPromise(Ledger);
      return runtime.runPromise(ledger.events(identity));
    },
    dispose: () => runtime.dispose(),
  };
};

describe("cloudflare-do durable process lifecycle", () => {
  runDurableProcessLifecycleContract("cloudflare-do", makeDriver);
});
