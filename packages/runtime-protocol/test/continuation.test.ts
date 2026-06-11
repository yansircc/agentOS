import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  agentRunInterruptedEvent,
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  isContinuationRef,
  submitResumeDecisionFromContinuationRef,
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
    if (!result.ok) expect.fail("expected continuation ref");

    const wire = JSON.parse(JSON.stringify(result.ref)) as unknown;
    expect(isContinuationRef(wire)).toBe(true);
    if (!isContinuationRef(wire)) expect.fail("expected JSON round-tripped continuation ref");

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
});
