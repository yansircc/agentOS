import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { ImageResourceSettlementReconcileRequired, withImageResourceSettlement } from "../src";

describe("image resource settlement helper", () => {
  it.effect("settles reservations by consuming success and releasing failure", () =>
    Effect.gen(function* () {
      const successMarks: string[] = [];
      const success = yield* withImageResourceSettlement(Effect.succeed("ok"), {
        consume: (value) => Effect.sync(() => successMarks.push(`consume:${value}`)),
        release: (error) => Effect.sync(() => successMarks.push(`release:${String(error)}`)),
      });

      expect(success).toBe("ok");
      expect(successMarks).toEqual(["consume:ok"]);

      const failureMarks: string[] = [];
      const failure = yield* Effect.flip(
        withImageResourceSettlement(Effect.fail("bad"), {
          consume: () => Effect.sync(() => failureMarks.push("consume:unexpected")),
          release: (error) => Effect.sync(() => failureMarks.push(`release:${error}`)),
        }),
      );
      expect(failure).toBe("bad");
      expect(failureMarks).toEqual(["release:bad"]);
    }),
  );

  it.effect("reports consume settlement failures as reconcile-required instead of raw errors", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        withImageResourceSettlement(Effect.succeed("ok"), {
          consume: () => Effect.fail("consume failed"),
          release: () => Effect.void,
        }),
      );

      expect(failure).toBeInstanceOf(ImageResourceSettlementReconcileRequired);
      expect(failure).toMatchObject({
        _tag: "agent_os.image_resource_settlement_reconcile_required",
        phase: "consume",
        cause: "consume failed",
      });
    }),
  );

  it.effect("reports release settlement failures as reconcile-required", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        withImageResourceSettlement(Effect.fail("provider failed"), {
          consume: () => Effect.void,
          release: () => Effect.fail("release failed"),
        }),
      );

      expect(failure).toBeInstanceOf(ImageResourceSettlementReconcileRequired);
      expect(failure).toMatchObject({
        _tag: "agent_os.image_resource_settlement_reconcile_required",
        phase: "release",
        cause: "release failed",
      });
    }),
  );
});
