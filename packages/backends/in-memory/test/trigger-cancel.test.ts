import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import {
  DurableTriggerRegistry,
  TriggerPump,
  triggerParseOk,
  type DurableTrigger,
} from "@agent-os/runtime";
import { createInMemoryRuntimeBackend } from "../src";
import { runtimeEventIdentity, truthIdentity } from "./identity";

interface Intent {
  readonly label: string;
}

const makeTrigger = (calls: string[]): DurableTrigger<Intent, Intent> => ({
  kind: "test.cancel",
  intentEventKind: "test.cancel.requested",
  cancellation: "cooperative",
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
  commitCancelled: (intent, cancellation, tx) => {
    tx.insertEvent({
      kind: "test.cancel.cancelled",
      payload: { label: intent.label, reason: cancellation.reason ?? null },
    });
  },
});

describe("in-memory durable trigger cancellation", () => {
  it("commits trigger-owned cancellation facts for pending trigger rows", async () => {
    const backend = createInMemoryRuntimeBackend({
      identity: truthIdentity("scope"),
      triggers: [makeTrigger([])],
    });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const registry = await runtime.runPromise(DurableTriggerRegistry);
      const intent = await runtime.runPromise(
        backend.state.commitTriggerIntent(
          runtimeEventIdentity("scope"),
          10,
          registry,
          "test.cancel",
          (trigger) => ({
            kind: trigger.intentEventKind,
            payload: { label: "one" },
          }),
        ),
      );
      const pump = await runtime.runPromise(TriggerPump);
      const cancel = await runtime.runPromise(
        pump.cancelTrigger({
          triggerKind: "test.cancel",
          intentEventId: intent.id,
          reason: "user",
        }),
      );
      const events = backend.state.snapshot(truthIdentity("scope"));
      expect(cancel).toEqual({ status: "cancelled", cancelled: 1 });
      expect(events.filter((event) => event.kind === "test.cancel.cancelled")).toHaveLength(1);
      expect(backend.state.duePending(runtimeEventIdentity("scope"), 11)).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });

  it("returns ignored without mutating pending ignored trigger rows", async () => {
    const ignoredTrigger = {
      ...makeTrigger([]),
      kind: "test.ignored_cancel",
      intentEventKind: "test.ignored_cancel.requested",
      cancellation: "ignored",
      commitCancelled: () => undefined,
    } satisfies DurableTrigger<Intent, Intent>;
    const backend = createInMemoryRuntimeBackend({
      identity: truthIdentity("scope"),
      triggers: [ignoredTrigger],
    });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const registry = await runtime.runPromise(DurableTriggerRegistry);
      const intent = await runtime.runPromise(
        backend.state.commitTriggerIntent(
          runtimeEventIdentity("scope"),
          10,
          registry,
          "test.ignored_cancel",
          (trigger) => ({
            kind: trigger.intentEventKind,
            payload: { label: "ignored" },
          }),
        ),
      );
      const pump = await runtime.runPromise(TriggerPump);
      const cancel = await runtime.runPromise(
        pump.cancelTrigger({
          triggerKind: "test.ignored_cancel",
          intentEventId: intent.id,
          reason: "user",
        }),
      );
      expect(cancel).toEqual({ status: "ignored" });
      expect(backend.state.duePending(runtimeEventIdentity("scope"), 11)).toHaveLength(1);
      expect(backend.state.snapshot(truthIdentity("scope")).map((event) => event.kind)).toEqual([
        "test.ignored_cancel.requested",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("redrives expired claims and commits one terminal fact", async () => {
    const calls: string[] = [];
    const backend = createInMemoryRuntimeBackend({
      identity: truthIdentity("scope"),
      triggers: [makeTrigger(calls)],
    });
    const runtime = ManagedRuntime.make(backend.layer);
    try {
      const registry = await runtime.runPromise(DurableTriggerRegistry);
      await runtime.runPromise(
        backend.state.commitTriggerIntent(
          runtimeEventIdentity("scope"),
          10,
          registry,
          "test.cancel",
          (trigger) => ({
            kind: trigger.intentEventKind,
            payload: { label: "two" },
          }),
        ),
      );
      const pump = await runtime.runPromise(TriggerPump);
      const first = runtime.runPromise(pump.drainDue(10));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runtime.runPromise(pump.drainDue(12));
      await first;
      const done = backend.state
        .snapshot(truthIdentity("scope"))
        .filter((event) => event.kind === "test.cancel.done");
      expect(calls).toEqual(["normal", "redrive"]);
      expect(done).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });
});
