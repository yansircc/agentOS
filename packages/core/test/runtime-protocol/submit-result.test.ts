import { describe, expect, it } from "@effect/vitest";

import { decodeSubmitResult, type SubmitResult } from "../../src/runtime-protocol";

const continuation = {
  kind: "agent.run.continuation" as const,
  scopeRef: { kind: "conversation" as const, scopeId: "submit-result" },
  afterEventId: 7,
  runId: 1,
  turn: { id: 1, index: 0 },
  interruptId: "interrupt-1",
  interruptionEventId: 7,
  gateRef: "gate-1",
};

describe("SubmitResult decoder", () => {
  it("accepts delivered, failed, and non-error aborted terminal projections", () => {
    const delivered: SubmitResult = {
      ok: true,
      status: "delivered",
      runId: 1,
      final: "done",
      eventCount: 3,
      tokensUsed: 5,
    };
    const failed: SubmitResult = {
      ok: false,
      status: "failed",
      runId: 1,
      reason: "agent.aborted.retries",
      eventCount: 3,
      tokensUsed: 5,
    };
    const aborted: SubmitResult = {
      ok: false,
      status: "aborted",
      runId: 1,
      reason: "rejected",
      eventCount: 4,
      tokensUsed: 5,
    };

    expect(decodeSubmitResult(delivered)).toEqual(delivered);
    expect(decodeSubmitResult(failed)).toEqual(failed);
    expect(decodeSubmitResult(aborted)).toEqual(aborted);
    expect(decodeSubmitResult({ ...aborted, reason: "tool_error" })).toBeNull();
  });

  it("requires owner-shaped continuation for interrupted terminal projections", () => {
    const interrupted = {
      ok: false,
      status: "interrupted",
      runId: 1,
      reason: "interrupted",
      eventCount: 3,
      tokensUsed: 5,
      interruptId: "interrupt-1",
      turn: { id: 1, index: 0 },
      gateRef: "gate-1",
      continuation,
      extra: "dropped",
    };

    expect(decodeSubmitResult(interrupted)).toEqual({
      ok: false,
      status: "interrupted",
      runId: 1,
      reason: "interrupted",
      eventCount: 3,
      tokensUsed: 5,
      interruptId: "interrupt-1",
      turn: { id: 1, index: 0 },
      gateRef: "gate-1",
      continuation,
    });
    expect(decodeSubmitResult({ ...interrupted, continuation: undefined })).toBeNull();
    expect(
      decodeSubmitResult({
        ...interrupted,
        continuation: { ...continuation, gateRef: "other" },
      }),
    ).toBeNull();
    expect(
      decodeSubmitResult({
        ...interrupted,
        turn: { id: 2, index: 0 },
        continuation: { ...continuation, turn: { id: 2, index: 0 } },
      }),
    ).toBeNull();
  });
});
