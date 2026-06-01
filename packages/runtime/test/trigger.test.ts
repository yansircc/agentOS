import { Effect, Exit } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { DurableTriggerCommitReturnedThenable } from "@agent-os/kernel";
import {
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  runSynchronousTriggerCommit,
  makeDurableTriggerRegistry,
  parseScheduledEventIntentPayload,
  scheduledEventIntentPayload,
  scheduledEventTrigger,
  triggerParseOk,
  type DurableTrigger,
} from "../src/trigger";

const trigger = (kind: string): DurableTrigger<unknown, { readonly ok: boolean }> => ({
  kind,
  intentEventKind: `${kind}.requested`,
  parseIntent: (raw) => triggerParseOk(raw),
  acquire: () => Effect.succeed({ ok: true }),
  commit: () => undefined,
});

describe("durable trigger runtime algebra", () => {
  it.effect("rejects duplicate trigger kinds at registry construction", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeDurableTriggerRegistry([trigger("same"), trigger("same")]),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("models acquisition failure as an outcome value", () =>
    Effect.gen(function* () {
      const failed: DurableTrigger<
        unknown,
        { readonly ok: true } | { readonly ok: false; readonly reason: string }
      > = {
        kind: "failed-as-value",
        intentEventKind: "failed-as-value.requested",
        parseIntent: (raw: unknown) => triggerParseOk(raw),
        acquire: () => Effect.succeed({ ok: false, reason: "provider unavailable" }),
        commit: () => undefined,
      };

      const outcome = yield* failed.acquire(
        {},
        {
          scope: "scope",
          now: 1,
          dueWorkId: 2,
          intentEventId: 3,
          signal: new AbortController().signal,
          acquireMode: "normal",
        },
      );
      expect(outcome).toEqual({ ok: false, reason: "provider unavailable" });
    }),
  );

  it.effect("passes cancellation context through acquire", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const seen: Array<{ readonly aborted: boolean; readonly mode: string }> = [];
      const cancellable: DurableTrigger<unknown, { readonly ok: true }> = {
        kind: "cancellable",
        intentEventKind: "cancellable.requested",
        parseIntent: (raw: unknown) => triggerParseOk(raw),
        acquire: (_intent, ctx) => {
          seen.push({ aborted: ctx.signal.aborted, mode: ctx.acquireMode });
          return Effect.succeed({ ok: true });
        },
        commit: () => undefined,
      };

      controller.abort("test");
      yield* cancellable.acquire(
        {},
        {
          scope: "scope",
          now: 1,
          dueWorkId: 2,
          intentEventId: 3,
          signal: controller.signal,
          acquireMode: "redrive",
        },
      );

      expect(seen).toEqual([{ aborted: true, mode: "redrive" }]);
    }),
  );

  it("rejects thenable cancellation commits with the same sync guard", () => {
    const failure = runSynchronousTriggerCommit("scope", "kind", () => Promise.resolve());
    expect(failure).toBeInstanceOf(DurableTriggerCommitReturnedThenable);
  });

  it.effect("owns the scheduled event trigger value", () =>
    Effect.gen(function* () {
      const intent = scheduledEventIntentPayload("app.scheduled", { job: "one" });
      expect(parseScheduledEventIntentPayload(intent)).toEqual({
        ok: true,
        intent,
      });
      expect(scheduledEventTrigger.kind).toBe("scheduled_event");
      expect(scheduledEventTrigger.intentEventKind).toBe(DURABLE_TRIGGER_SCHEDULED_REQUESTED);

      const outcome = yield* scheduledEventTrigger.acquire(intent, {
        scope: "scope",
        now: 1,
        dueWorkId: 2,
        intentEventId: 3,
        signal: new AbortController().signal,
        acquireMode: "normal",
      });
      expect(outcome).toEqual(intent);
    }),
  );
});
