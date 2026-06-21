import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { DurableProcessLifecycleState } from "@agent-os/backend-protocol";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  triggerParseFail,
  triggerParseOk,
  type AnyDurableTrigger,
  type DurableTrigger,
} from "./durable-trigger-contract";

interface LifecycleIntent {
  readonly id: string;
}

export interface DurableProcessLifecycleDriver {
  readonly enqueue: (
    trigger: AnyDurableTrigger,
    payload: LifecycleIntent,
    fireAt: number,
  ) => Promise<{ readonly id: number }>;
  readonly drainDue: (now: number) => Promise<void>;
  readonly cancel: (triggerKind: string, intentEventId: number, reason?: string) => Promise<void>;
  readonly processes: () => Promise<ReadonlyArray<DurableProcessLifecycleState>>;
  readonly events: () => Promise<ReadonlyArray<LedgerEvent>>;
  readonly dispose: () => Promise<void>;
}

export type DurableProcessLifecycleDriverFactory = (
  triggers: ReadonlyArray<AnyDurableTrigger>,
) => DurableProcessLifecycleDriver | Promise<DurableProcessLifecycleDriver>;

const parseLifecycleIntent = (raw: unknown) => {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { readonly id?: unknown }).id !== "string"
  ) {
    return triggerParseFail<LifecycleIntent>("lifecycle intent malformed");
  }
  return triggerParseOk({ id: (raw as { readonly id: string }).id });
};

const completedTrigger = {
  kind: "lifecycle.completed",
  intentEventKind: "lifecycle.completed.requested",
  cancellation: "cooperative",
  parseIntent: parseLifecycleIntent,
  acquire: (intent) => Effect.succeed(intent),
  commit: (outcome, tx) => {
    tx.insertEvent({ kind: "lifecycle.completed.done", payload: outcome });
  },
  commitCancelled: (intent, cancellation, tx) => {
    tx.insertEvent({
      kind: "lifecycle.completed.cancelled",
      payload: {
        id: intent.id,
        ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
      },
    });
  },
} satisfies DurableTrigger<LifecycleIntent, LifecycleIntent>;

const createBlockingTrigger = () => {
  let acquireCount = 0;
  const acquireWaiters: Array<() => void> = [];
  const releases: Array<() => void> = [];

  const waitForAcquire = (count: number): Promise<void> => {
    if (acquireCount >= count) return Promise.resolve();
    return new Promise((resolve) => {
      acquireWaiters.push(() => {
        if (acquireCount >= count) resolve();
      });
    });
  };

  const releaseAcquire = (index: number): void => {
    releases[index]?.();
  };

  const trigger = {
    kind: "lifecycle.blocking",
    intentEventKind: "lifecycle.blocking.requested",
    cancellation: "cooperative",
    acquireDeadlineMs: 1,
    parseIntent: parseLifecycleIntent,
    acquire: (intent, ctx) =>
      Effect.promise(
        () =>
          new Promise<{ readonly id: string; readonly mode: "normal" | "redrive" }>((resolve) => {
            const index = acquireCount;
            acquireCount += 1;
            releases[index] = () => resolve({ id: intent.id, mode: ctx.acquireMode });
            for (const waiter of acquireWaiters.splice(0)) waiter();
          }),
      ),
    commit: (outcome, tx) => {
      tx.insertEvent({ kind: "lifecycle.blocking.done", payload: outcome });
    },
    commitCancelled: (intent, cancellation, tx) => {
      tx.insertEvent({
        kind: "lifecycle.blocking.cancelled",
        payload: {
          id: intent.id,
          ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
        },
      });
    },
  } satisfies DurableTrigger<
    LifecycleIntent,
    { readonly id: string; readonly mode: "normal" | "redrive" }
  >;

  return { trigger, waitForAcquire, releaseAcquire };
};

const phaseFor = (
  states: ReadonlyArray<DurableProcessLifecycleState>,
  intentEventId: number,
): DurableProcessLifecycleState["phase"] | undefined =>
  states.find((state) => state.intentEventId === intentEventId)?.phase;

const stateFor = (
  states: ReadonlyArray<DurableProcessLifecycleState>,
  intentEventId: number,
): DurableProcessLifecycleState | undefined =>
  states.find((state) => state.intentEventId === intentEventId);

const payloadsOf = <T>(events: ReadonlyArray<LedgerEvent>, kind: string): ReadonlyArray<T> =>
  events.filter((event) => event.kind === kind).map((event) => event.payload as T);

export const runDurableProcessLifecycleContract = (
  name: string,
  makeDriver: DurableProcessLifecycleDriverFactory,
): void => {
  describe(name + " durable process lifecycle", () => {
    it.effect("classifies scheduled completed and cancelled terminal states", () =>
      Effect.withSpan("agentos.test.durable_process_lifecycle.terminal_states")(
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const driver = yield* Effect.acquireRelease(
                Effect.promise(() => Promise.resolve(makeDriver([completedTrigger]))),
                (driver) => Effect.promise(() => driver.dispose()),
              );

              const scheduled = yield* Effect.promise(() =>
                driver.enqueue(completedTrigger, { id: "scheduled" }, 10),
              );
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), scheduled.id)).toBe(
                "scheduled",
              );

              yield* Effect.promise(() => driver.drainDue(10));
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), scheduled.id)).toBe(
                "completed",
              );
              yield* Effect.promise(() =>
                driver.cancel(completedTrigger.kind, scheduled.id, "cancel after completed"),
              );
              yield* Effect.promise(() => driver.drainDue(10));
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), scheduled.id)).toBe(
                "completed",
              );

              const cancelled = yield* Effect.promise(() =>
                driver.enqueue(completedTrigger, { id: "cancelled" }, 20),
              );
              yield* Effect.promise(() =>
                driver.cancel(completedTrigger.kind, cancelled.id, "cancel before acquire"),
              );
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), cancelled.id)).toBe(
                "cancelled",
              );
              yield* Effect.promise(() => driver.drainDue(20));
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), cancelled.id)).toBe(
                "cancelled",
              );
            }),
          );
        }),
      ),
    );

    it.effect("classifies claimed cancel-requested and redriven active states", () =>
      Effect.withSpan("agentos.test.durable_process_lifecycle.active_states")(
        Effect.gen(function* () {
          const blocking = createBlockingTrigger();
          yield* Effect.scoped(
            Effect.gen(function* () {
              const driver = yield* Effect.acquireRelease(
                Effect.promise(() => Promise.resolve(makeDriver([blocking.trigger]))),
                (driver) => Effect.promise(() => driver.dispose()),
              );

              const claimed = yield* Effect.promise(() =>
                driver.enqueue(blocking.trigger, { id: "claimed" }, 100),
              );
              const firstDrain = driver.drainDue(100);
              yield* Effect.promise(() => blocking.waitForAcquire(1));
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), claimed.id)).toBe(
                "claimed",
              );
              yield* Effect.promise(() =>
                driver.cancel(blocking.trigger.kind, claimed.id, "cancel while claimed"),
              );
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), claimed.id)).toBe(
                "cancel_requested",
              );
              blocking.releaseAcquire(0);
              yield* Effect.promise(() => firstDrain);
              expect(
                stateFor(yield* Effect.promise(() => driver.processes()), claimed.id),
              ).toMatchObject({
                phase: "completed_after_cancel_requested",
                cancellation: { reason: "cancel while claimed" },
              });

              const redriven = yield* Effect.promise(() =>
                driver.enqueue(blocking.trigger, { id: "redriven" }, 200),
              );
              const redriveFirstDrain = driver.drainDue(200);
              yield* Effect.promise(() => blocking.waitForAcquire(2));
              const redriveSecondDrain = driver.drainDue(202);
              yield* Effect.promise(() => blocking.waitForAcquire(3));
              expect(phaseFor(yield* Effect.promise(() => driver.processes()), redriven.id)).toBe(
                "redriven",
              );
              blocking.releaseAcquire(2);
              yield* Effect.promise(() => redriveSecondDrain);
              blocking.releaseAcquire(1);
              yield* Effect.promise(() => redriveFirstDrain);

              expect(
                stateFor(yield* Effect.promise(() => driver.processes()), redriven.id),
              ).toMatchObject({
                phase: "completed",
                redriveCount: 1,
              });
              yield* Effect.promise(() => driver.drainDue(202));
              const redrivenDone = payloadsOf<{ readonly id: string; readonly mode: string }>(
                yield* Effect.promise(() => driver.events()),
                "lifecycle.blocking.done",
              ).filter((payload) => payload.id === "redriven");
              expect(redrivenDone).toEqual([{ id: "redriven", mode: "redrive" }]);
            }),
          );
        }),
      ),
    );
  });
};
