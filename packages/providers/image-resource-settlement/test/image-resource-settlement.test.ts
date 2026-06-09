import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { withImageResourceSettlement } from "../src";

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
});
