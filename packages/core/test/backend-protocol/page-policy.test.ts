import { describe, expect, it } from "@effect/vitest";
import { BACKEND_PAGE_POLICY, normalizeBackendPageLimit } from "@agent-os/core/backend-protocol";

describe("backend page policy", () => {
  it("normalizes the complete numeric input class from one protocol fact", () => {
    expect(
      [undefined, 0, -1, 1.9, 1_001, Number.NaN, Number.POSITIVE_INFINITY].map((limit) =>
        normalizeBackendPageLimit(limit),
      ),
    ).toEqual([1_000, 0, 0, 1, 1_000, 1_000, 1_000]);
    expect(BACKEND_PAGE_POLICY).toEqual({ defaultLimit: 1_000, maxLimit: 1_000 });
  });
});
