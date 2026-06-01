import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { UnregisteredDurableTriggerKind } from "@agent-os/kernel/errors";
import {
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  DurableTriggerRegistry,
  Dispatch,
  TriggerPump,
  makeDurableTriggerRegistry,
  scheduledEventTrigger,
} from "@agent-os/runtime";
import { DISPATCH_MAX_ATTEMPTS } from "@agent-os/backend-protocol";
import { type DispatchTargetRegistry } from "../src/dispatch";
import {
  commitDurableTriggerIntent,
  enqueueScheduledEvent,
  ensureDueWorkSchema,
  findNextDue,
} from "../src/due-work";
import { EventBusLive } from "../src/ledger";
import { makeCloudflareBackendCoreLayer } from "../src/runtime-core";
import { TriggerPumpLive } from "../src/trigger-pump";
import { makeInMemoryDurableObjectState } from "./_in-memory-do";

const bindingRef = bindingMaterialRef({
  provider: "cloudflare",
  bindingKind: "durable_object",
  ref: "dead",
});

const bindingKey = materialRefKey(bindingRef);

const deadTargets: DispatchTargetRegistry = {
  [bindingKey]: {
    deliver: () => Promise.reject("dead target"),
  },
};

const dispatchSpec = {
  target: {
    bindingRef,
    scope: "receiver",
    scopeRef: { kind: "conversation" as const, scopeId: "receiver" },
  },
  event: "app.deliver",
  data: { value: 1 },
  idempotencyKey: "dead-target",
};

describe("due-work alarm protocol", () => {
  it.effect("setAlarm failure during scheduled enqueue commits no due-work row", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState({
        setAlarm: () => Promise.reject(new Error("alarm unavailable")),
      });
      const sql = state.storage.sql;
      yield* ensureDueWorkSchema(sql);
      const registry = yield* makeDurableTriggerRegistry([scheduledEventTrigger]);

      const exit = yield* Effect.exit(
        enqueueScheduledEvent(
          state,
          sql,
          "sender",
          1,
          10,
          registry,
          scheduledEventTrigger.kind,
          "app.scheduled",
          { job: "one" },
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sql.exec("SELECT * FROM due_work").toArray()).toHaveLength(0);
      expect(sql.exec("SELECT * FROM events").toArray()).toHaveLength(0);
      const alarm = yield* Effect.promise(() => state.storage.getAlarm());
      expect(alarm).toBeNull();
    }),
  );

  it.effect("scheduled due-work points to a scheduled intent ledger fact", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      yield* ensureDueWorkSchema(sql);
      const registry = yield* makeDurableTriggerRegistry([scheduledEventTrigger]);

      const intent = yield* enqueueScheduledEvent(
        state,
        sql,
        "sender",
        1,
        10,
        registry,
        scheduledEventTrigger.kind,
        "app.scheduled",
        { job: "one" },
      );

      expect(intent.kind).toBe(DURABLE_TRIGGER_SCHEDULED_REQUESTED);
      const due = sql.exec("SELECT kind, payload FROM due_work").toArray();
      expect(due).toHaveLength(1);
      expect(due[0]?.kind).toBe(scheduledEventTrigger.kind);
      expect(JSON.parse(due[0]?.payload as string)).toEqual({ intentEventId: intent.id });
    }),
  );

  it.effect("unregistered trigger submit fails before event due-work or alarm writes", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      yield* ensureDueWorkSchema(sql);
      const registry = yield* makeDurableTriggerRegistry([scheduledEventTrigger]);

      const exit = yield* Effect.exit(
        commitDurableTriggerIntent(state, sql, 10, registry, "missing.trigger", () => {
          throw new Error("writeIntent should not run");
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(UnregisteredDurableTriggerKind);
          expect((failure.value as UnregisteredDurableTriggerKind).kind).toBe("missing.trigger");
        }
      }
      expect(sql.exec("SELECT * FROM events").toArray()).toHaveLength(0);
      expect(sql.exec("SELECT * FROM due_work").toArray()).toHaveLength(0);
      expect(yield* Effect.promise(() => state.storage.getAlarm())).toBeNull();
    }),
  );

  it.effect("unknown due-work kind fails trigger drain and remains pending", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      yield* ensureDueWorkSchema(sql);
      sql.exec(
        "INSERT INTO due_work (fire_at, kind, payload) VALUES (?, ?, ?)",
        10,
        "unknown_retry",
        JSON.stringify({ intentEventId: 1 }),
      );
      const runtime = ManagedRuntime.make(
        makeCloudflareBackendCoreLayer(state, {}, "sender", new Map(), deadTargets),
      );
      const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));

      const exit = yield* Effect.exit(triggerPump.drainDue(10));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray()).toHaveLength(
        1,
      );
      yield* Effect.promise(() => runtime.dispose());
    }),
  );

  it.effect("empty trigger registry fails closed and leaves due-work pending", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      yield* ensureDueWorkSchema(sql);
      sql.exec(
        "INSERT INTO due_work (fire_at, kind, payload) VALUES (?, ?, ?)",
        10,
        "unknown_retry",
        JSON.stringify({ intentEventId: 1 }),
      );
      const runtime = ManagedRuntime.make(
        TriggerPumpLive(state, "sender").pipe(
          Layer.provide(
            Layer.mergeAll(
              EventBusLive(new Map()),
              Layer.succeed(DurableTriggerRegistry, new Map()),
            ),
          ),
        ),
      );
      const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));

      const exit = yield* Effect.exit(triggerPump.drainDue(10));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray()).toHaveLength(
        1,
      );
      yield* Effect.promise(() => runtime.dispose());
    }),
  );

  it.effect(
    "dispatch terminal failure stops after max committed attempts with no next due-work",
    () =>
      Effect.gen(function* () {
        const state = makeInMemoryDurableObjectState();
        const sql = state.storage.sql;
        const runtime = ManagedRuntime.make(
          makeCloudflareBackendCoreLayer(state, {}, "sender", new Map(), deadTargets),
        );

        const dispatch = yield* Effect.promise(() => runtime.runPromise(Dispatch));
        const triggerPump = yield* Effect.promise(() => runtime.runPromise(TriggerPump));
        yield* Effect.promise(() => runtime.runPromise(dispatch.dispatchToScope(dispatchSpec)));

        for (;;) {
          const next = yield* findNextDue(sql);
          if (next === null) break;
          yield* Effect.promise(() => runtime.runPromise(triggerPump.drainDue(next)));
        }

        const failed = sql
          .exec("SELECT payload FROM events WHERE kind = 'dispatch.outbound.failed'")
          .toArray();
        expect(failed).toHaveLength(DISPATCH_MAX_ATTEMPTS);
        const lastPayload = failed.at(-1)?.payload;
        const lastPayloadText = typeof lastPayload === "string" ? lastPayload : "";
        expect(lastPayloadText).not.toBe("");
        const last = JSON.parse(lastPayloadText) as {
          readonly attempt: number;
          readonly terminal: boolean;
          readonly nextAttemptAt?: number;
        };
        expect(last.attempt).toBe(DISPATCH_MAX_ATTEMPTS);
        expect(last.terminal).toBe(true);
        expect(last.nextAttemptAt).toBeUndefined();

        const outbox = sql.exec("SELECT attempts FROM dispatch_outbox").toArray();
        expect(Number(outbox[0]?.attempts)).toBe(DISPATCH_MAX_ATTEMPTS);
        expect(
          sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray(),
        ).toHaveLength(0);
        yield* Effect.promise(() => runtime.dispose());
      }),
  );
});
