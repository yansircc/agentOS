import { describe, expect, it } from "@effect/vitest";
import {
  durableProcessLifecycleState,
  type DurableProcessLifecycleSnapshot,
} from "@agent-os/core/backend-protocol";

const snapshot = (
  overrides: Partial<DurableProcessLifecycleSnapshot> = {},
): DurableProcessLifecycleSnapshot => ({
  id: 1,
  fireAt: 10,
  kind: "test.trigger",
  intentEventId: 2,
  completedAt: null,
  claimedAt: null,
  claimToken: null,
  claimDeadlineAt: null,
  redriveCount: 0,
  cancelRequestedAt: null,
  cancelReason: null,
  cancelledAt: null,
  ...overrides,
});

const claim = {
  claimedAt: 11,
  claimToken: "claim-1",
  claimDeadlineAt: 12,
} as const;

describe("durable process lifecycle row algebra", () => {
  it("classifies every writer-produced lifecycle shape", () => {
    const legal = [
      ["scheduled", {}],
      ["claimed", claim],
      ["redriven", { ...claim, redriveCount: 1 }],
      ["cancel_requested", { cancelRequestedAt: 13 }],
      ["cancel_requested", { ...claim, cancelRequestedAt: 13, cancelReason: "stop" }],
      ["completed", { completedAt: 14 }],
      ["completed", { ...claim, completedAt: 14 }],
      [
        "completed_after_cancel_requested",
        { ...claim, completedAt: 14, cancelRequestedAt: 13, cancelReason: "stop" },
      ],
      ["cancelled", { completedAt: 14, cancelRequestedAt: 13, cancelledAt: 14 }],
      [
        "cancelled",
        {
          ...claim,
          redriveCount: 1,
          completedAt: 14,
          cancelRequestedAt: 13,
          cancelReason: "stop",
          cancelledAt: 14,
        },
      ],
    ] as const;

    for (const [phase, overrides] of legal) {
      expect(durableProcessLifecycleState(snapshot(overrides))).toMatchObject({
        ok: true,
        state: { phase },
      });
    }
  });

  it("rejects partial, empty, and redrive-without-claim tuples", () => {
    const illegal = [
      { claimedAt: 11 },
      { claimToken: "claim-1" },
      { claimDeadlineAt: 12 },
      { claimedAt: 11, claimToken: "claim-1" },
      { claimedAt: 11, claimDeadlineAt: 12 },
      { claimToken: "claim-1", claimDeadlineAt: 12 },
      { claimedAt: 11, claimToken: "", claimDeadlineAt: 12 },
      { redriveCount: 1 },
    ] satisfies ReadonlyArray<Partial<DurableProcessLifecycleSnapshot>>;

    for (const overrides of illegal) {
      expect(durableProcessLifecycleState(snapshot(overrides)).ok).toBe(false);
    }
  });

  it("rejects cancellation relations outside the writer algebra", () => {
    const illegal = [
      { cancelReason: "stop" },
      { cancelledAt: 14 },
      { completedAt: 14, cancelledAt: 14 },
      { completedAt: 14, cancelRequestedAt: 13, cancelledAt: 15 },
    ] satisfies ReadonlyArray<Partial<DurableProcessLifecycleSnapshot>>;

    for (const overrides of illegal) {
      expect(durableProcessLifecycleState(snapshot(overrides)).ok).toBe(false);
    }
  });

  it("rejects every non-finite nullable timestamp", () => {
    const fields = [
      "completedAt",
      "claimedAt",
      "claimDeadlineAt",
      "cancelRequestedAt",
      "cancelledAt",
    ] as const;

    for (const field of fields) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(durableProcessLifecycleState(snapshot({ [field]: value })).ok).toBe(false);
      }
    }
  });

  it("rejects negative and non-integer redrive counts", () => {
    expect(durableProcessLifecycleState(snapshot({ redriveCount: -1 })).ok).toBe(false);
    expect(durableProcessLifecycleState(snapshot({ redriveCount: 0.5 })).ok).toBe(false);
  });
});
