import { describe, expect, it } from "@effect/vitest";
import type { Recorded } from "@agent-os/kernel";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  agentRunInterruptedEvent,
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  decisionContinuationCause,
  isContinuationRef,
  isContinuationCause,
  isRecoveryAttemptRecord,
  recordedContinuationRefFromUnknown,
  submitResumeDecisionFromContinuationRef,
  type ContinuationRef,
  type RuntimeEventCommitSpec,
} from "../src";

const scope = "continuation-protocol-test";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const ledgerEvent = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

describe("runtime continuation refs", () => {
  it("derives a serializable continuation ref from a decision-bound interruption fact", () => {
    const decoded = decodeRuntimeLedgerEvent(
      ledgerEvent(
        7,
        agentRunInterruptedEvent({
          ...identity,
          runId: 3,
          turn: { id: 3, index: 1 },
          interruptId: "decision:publish",
          reason: "approval_required",
          resumeSchema: { type: "object", required: ["approved"] },
          tokensUsed: 11,
          decision: {
            gateRef: "decision_gate:publish",
            subjectRef: "tool:publish",
            toolCallId: "call-1",
            toolName: "publish",
          },
        }),
      ),
    );
    if (decoded._tag !== "runtime" || decoded.event.kind !== "agent.run.interrupted") {
      expect.fail("expected interrupted runtime event");
    }

    const result = continuationRefFromInterruptedEvent(decoded.event);
    if (!result.ok) expect.fail("expected continuation ref");
    const recordedRef: Recorded<ContinuationRef> = result.ref;
    expect(recordedRef.value.gateRef).toBe("decision_gate:publish");
    expect(Object.prototype.propertyIsEnumerable.call(result.ref, "value")).toBe(false);
    expect(result).toEqual({
      ok: true,
      ref: {
        kind: "agent.run.continuation",
        scopeRef: { kind: "conversation", scopeId: scope },
        afterEventId: 7,
        runId: 3,
        turn: { id: 3, index: 1 },
        interruptId: "decision:publish",
        interruptionEventId: 7,
        gateRef: "decision_gate:publish",
      },
    });

    const wire = JSON.parse(JSON.stringify(result.ref)) as unknown;
    expect(isContinuationRef(wire)).toBe(true);
    if (!isContinuationRef(wire)) expect.fail("expected JSON round-tripped continuation ref");
    const reparsed = recordedContinuationRefFromUnknown(wire);
    if (reparsed === null) expect.fail("expected recorded continuation ref");
    expect(reparsed.value.gateRef).toBe("decision_gate:publish");
    expect(Object.prototype.propertyIsEnumerable.call(reparsed, "value")).toBe(false);

    expect(
      submitResumeDecisionFromContinuationRef(wire, {
        decisionRef: "decision/approved",
        resume: { approved: true },
      }),
    ).toEqual({
      runId: 3,
      turn: { id: 3, index: 1 },
      interruptId: "decision:publish",
      gateRef: "decision_gate:publish",
      decisionRef: "decision/approved",
      resume: { approved: true },
    });
    expect(isContinuationRef({ ...wire, turn: { id: 4, index: 1 } })).toBe(false);
    expect(recordedContinuationRefFromUnknown({ ...wire, turn: { id: 4, index: 1 } })).toBeNull();
  });

  it("does not fabricate a continuation ref for an interruption without a decision binding", () => {
    const decoded = decodeRuntimeLedgerEvent(
      ledgerEvent(
        8,
        agentRunInterruptedEvent({
          ...identity,
          runId: 4,
          turn: { id: 4, index: 0 },
          interruptId: "manual",
          reason: "manual_pause",
          resumeSchema: {},
          tokensUsed: 1,
        }),
      ),
    );
    if (decoded._tag !== "runtime" || decoded.event.kind !== "agent.run.interrupted") {
      expect.fail("expected interrupted runtime event");
    }

    expect(continuationRefFromInterruptedEvent(decoded.event)).toEqual({
      ok: false,
      reason: "interruption_missing_decision_binding",
    });
  });

  it("serializes decision and recovery verdict continuation causes without a live handle", () => {
    const decisionCause = decisionContinuationCause({
      decisionRef: "decision/approved",
      resume: { approved: true },
    });
    expect(isContinuationCause(JSON.parse(JSON.stringify(decisionCause)))).toBe(true);

    const recoveryCause = {
      kind: "recovery_verdict" as const,
      verdictRef: "verdict/invalid-args/1",
      verdict: "recoverable" as const,
      observation: {
        publicMessage: "Tool arguments did not match the tool schema.",
        diagnosticRefs: [{ eventId: 9, reason: "invalid_args" }],
        attributes: [{ key: "tool", value: "write_file" }],
      },
      fingerprint: {
        owner: "agentos" as const,
        value: "failure:invalid_args:invalid_args:write_file:decode",
      },
    };
    const wireCause = JSON.parse(JSON.stringify(recoveryCause)) as unknown;
    expect(isContinuationCause(wireCause)).toBe(true);
    expect(
      isRecoveryAttemptRecord({
        eventId: 10,
        ts: 100,
        cause: wireCause,
      }),
    ).toBe(true);
  });
});
