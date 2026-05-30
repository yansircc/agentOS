import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { defineStatelessReconciler } from "../src/reconciler";

describe("stateless reconciler trigger surface", () => {
  it.effect("detects and repairs by emitting facts without persistent step state", () =>
    Effect.gen(function* () {
      const emitted: Array<{ readonly event: string; readonly data: unknown }> = [];
      const reconciler = defineStatelessReconciler({
        id: "delivery.stale",
        detect: () => Effect.succeed([{ intentEventId: 1 }]),
        repair: (detected, context) =>
          context.emit("delivery.redrive.requested", {
            intentEventId: detected.intentEventId,
          }),
      });

      const detected = yield* reconciler.detect();
      yield* Effect.forEach(
        detected,
        (item) =>
          reconciler.repair(item, {
            emit: (event, data) =>
              Effect.sync(() => {
                emitted.push({ event, data });
              }),
          }),
        { discard: true },
      );

      expect(reconciler.id).toBe("delivery.stale");
      expect(emitted).toEqual([
        {
          event: "delivery.redrive.requested",
          data: { intentEventId: 1 },
        },
      ]);
    }),
  );
});
