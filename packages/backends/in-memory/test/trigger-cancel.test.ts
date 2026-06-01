import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  DURABLE_TRIGGER_CANCELLED,
  DurableTriggerRegistry,
  TriggerPump,
  triggerParseOk,
  type DurableTrigger,
} from "@agent-os/runtime";
import { createInMemoryRuntimeBackend } from "../src";

interface Intent {
  readonly label: string;
}

const makeTrigger = (calls: string[]): DurableTrigger<Intent, Intent> => ({
  kind: "test.cancel",
  intentEventKind: "test.cancel.requested",
  acquireDeadlineMs: 1,
  parseIntent: (raw) => triggerParseOk(raw as Intent),
  acquire: (intent, ctx) =>
    Effect.gen(function* () {
      calls.push(ctx.acquireMode);
      if (ctx.acquireMode === "normal") {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      }
      return intent;
    }),
  commit: (outcome, tx) => {
    tx.insertEvent({ kind: "test.cancel.done", payload: outcome });
  },
});

describe("in-memory durable trigger cancellation", () => {
  it("writes the generic cancellation fact for pending trigger rows", async () => {
    const backend = createInMemoryRuntimeBackend({
      scope: "scope",
      triggers: [makeTrigger([])],
    });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const registry = await runtime.runPromise(DurableTriggerRegistry);
      const intent = await runtime.runPromise(
        backend.state.commitTriggerIntent("scope", 10, registry, "test.cancel", (trigger) => ({
          kind: trigger.intentEventKind,
          scope: "scope",
          payload: { label: "one" },
        })),
      );
      const pump = await runtime.runPromise(TriggerPump);
      const cancel = await runtime.runPromise(
        pump.cancelTrigger({
          triggerKind: "test.cancel",
          intentEventId: intent.id,
          reason: "user",
        }),
      );
      const events = backend.state.snapshot("scope");
      expect(cancel).toEqual({ status: "cancelled", cancelled: 1 });
      expect(events.filter((event) => event.kind === DURABLE_TRIGGER_CANCELLED)).toHaveLength(1);
      expect(backend.state.duePending(11)).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("redrives expired claims and commits one terminal fact", async () => {
    const calls: string[] = [];
    const backend = createInMemoryRuntimeBackend({
      scope: "scope",
      triggers: [makeTrigger(calls)],
    });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const registry = await runtime.runPromise(DurableTriggerRegistry);
      await runtime.runPromise(
        backend.state.commitTriggerIntent("scope", 10, registry, "test.cancel", (trigger) => ({
          kind: trigger.intentEventKind,
          scope: "scope",
          payload: { label: "two" },
        })),
      );
      const pump = await runtime.runPromise(TriggerPump);
      const first = runtime.runPromise(pump.drainDue(10));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.runPromise(pump.drainDue(12));
      await first;
      const done = backend.state
        .snapshot("scope")
        .filter((event) => event.kind === "test.cancel.done");
      expect(calls).toEqual(["normal", "redrive"]);
      expect(done).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
