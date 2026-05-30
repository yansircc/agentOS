import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { bindingMaterialRef, materialRefKey } from "@agent-os/kernel/material-ref";
import { Dispatch } from "@agent-os/runtime";
import { DISPATCH_MAX_ATTEMPTS, DUE_WORK_SCHEDULED_EVENT } from "@agent-os/backend-protocol";
import { DispatchLive, type DispatchTargetRegistry } from "../src/dispatch";
import {
  enqueueScheduledEvent,
  ensureDueWorkSchema,
  findNextDue,
  selectDueWork,
} from "../src/due-work";
import { EventBusLive } from "../src/ledger";
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

      const exit = yield* Effect.exit(
        enqueueScheduledEvent(state, sql, 10, "app.scheduled", { job: "one" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(sql.exec("SELECT * FROM due_work").toArray()).toHaveLength(0);
      const alarm = yield* Effect.promise(() => state.storage.getAlarm());
      expect(alarm).toBeNull();
    }),
  );

  it.effect(
    "setAlarm failure during delivery retry does not advance attempt or commit failed fact",
    () =>
      Effect.gen(function* () {
        let setAlarmCalls = 0;
        const state = makeInMemoryDurableObjectState({
          setAlarm: () => {
            setAlarmCalls += 1;
            if (setAlarmCalls === 2) {
              return Promise.reject(new Error("alarm unavailable"));
            }
          },
        });
        const sql = state.storage.sql;
        const eventBusLayer = EventBusLive(new Map());
        const runtime = ManagedRuntime.make(
          DispatchLive(state, "sender", deadTargets).pipe(Layer.provide(eventBusLayer)),
        );

        const dispatch = yield* Effect.promise(() => runtime.runPromise(Dispatch));
        const exit = yield* Effect.exit(
          Effect.tryPromise({
            try: () => runtime.runPromise(dispatch.dispatchToScope(dispatchSpec)),
            catch: (cause) => cause,
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(setAlarmCalls).toBe(2);
        expect(
          sql.exec("SELECT * FROM events WHERE kind = 'dispatch.outbound.failed'").toArray(),
        ).toHaveLength(0);

        const outbox = sql.exec("SELECT attempts, last_error FROM dispatch_outbox").toArray();
        expect(outbox).toHaveLength(1);
        expect(Number(outbox[0]?.attempts)).toBe(0);
        expect(outbox[0]?.last_error).toBeNull();

        const due = sql.exec("SELECT * FROM due_work WHERE completed_at IS NULL").toArray();
        expect(due).toHaveLength(1);
        yield* Effect.promise(() => runtime.dispose());
      }),
  );

  it.effect("unknown due-work kind fails due selection instead of being ignored", () =>
    Effect.gen(function* () {
      const state = makeInMemoryDurableObjectState();
      const sql = state.storage.sql;
      yield* ensureDueWorkSchema(sql);
      sql.exec(
        "INSERT INTO due_work (fire_at, kind, payload) VALUES (?, ?, ?)",
        10,
        "unknown_retry",
        "{}",
      );

      const exit = yield* Effect.exit(selectDueWork(sql, DUE_WORK_SCHEDULED_EVENT, 10));

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect(
    "dispatch terminal failure stops after max committed attempts with no next due-work",
    () =>
      Effect.gen(function* () {
        const state = makeInMemoryDurableObjectState();
        const sql = state.storage.sql;
        const eventBusLayer = EventBusLive(new Map());
        const runtime = ManagedRuntime.make(
          DispatchLive(state, "sender", deadTargets).pipe(Layer.provide(eventBusLayer)),
        );

        const dispatch = yield* Effect.promise(() => runtime.runPromise(Dispatch));
        yield* Effect.promise(() => runtime.runPromise(dispatch.dispatchToScope(dispatchSpec)));

        for (;;) {
          const next = yield* findNextDue(sql);
          if (next === null) break;
          yield* Effect.promise(() => runtime.runPromise(dispatch.drainDue(next)));
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
