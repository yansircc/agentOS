import { describe, expect, it } from "@effect/vitest";

import { imageJobIdempotencyKey } from "../src";

describe("image idempotency", () => {
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
});
