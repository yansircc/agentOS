import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { imageJobIdempotencyKey, withImageResourceSettlement } from "../src";

describe("image idempotency and settlement helpers", () => {
  it("builds stable image idempotency keys without storing dedup state", () => {
    const left = imageJobIdempotencyKey({
      sourceScope: "session-1",
      intentId: "intent-1",
      routeKey: "primary-image-route",
      prompt: "rainy neon street",
      aspectRatio: "16:9",
    });
    const right = imageJobIdempotencyKey({
      aspectRatio: "16:9",
      sourceScope: "session-1",
      intentId: "intent-1",
      prompt: "rainy neon street",
      routeKey: "primary-image-route",
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^image\.job\.[0-9a-f]{16}$/);
  });

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
});
