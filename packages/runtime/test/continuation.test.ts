import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { DECISION_GATE_KIND, settleDecisionGateConsumed } from "@agent-os/decision-gate";
import {
  agentRunInterruptedEvent,
  agentRunStartedEvent,
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";
import {
  projectContinuation,
  projectContinuationRefs,
  submitResumeDecisionFromContinuationProjection,
} from "../src/continuation";

const scope = "continuation-runtime-test";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const eventIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const decisionClaim = makePreClaim({
  operationRef: "decision_gate:continuation-runtime-test",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityClass: "decision", authorityId: scope },
  originRef: { originKind: "run", originId: "run:1" },
});

const runtimeEvent = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const continuationEvents = (): ReadonlyArray<LedgerEvent> => [
  runtimeEvent(1, agentRunStartedEvent({ ...identity, intent: "publish" })),
  runtimeEvent(
    2,
    agentRunInterruptedEvent({
      ...identity,
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "decision:publish",
      reason: "approval_required",
      resumeSchema: { type: "object" },
      tokensUsed: 5,
      decision: {
        gateRef: "decision_gate:publish",
        subjectRef: "tool:publish",
        toolCallId: "call-1",
        toolName: "publish",
      },
    }),
  ),
  {
    id: 3,
    ts: 30,
    kind: DECISION_GATE_KIND.REQUESTED,
    ...eventIdentity,
    payload: {
      gateRef: "decision_gate:publish",
      subjectRef: "tool:publish",
      claim: decisionClaim,
    },
  },
];

const refFrom = (events: ReadonlyArray<LedgerEvent>) => {
  const decoded = decodeRuntimeLedgerEvent(events[1]!);
  if (decoded._tag !== "runtime" || decoded.event.kind !== "agent.run.interrupted") {
    expect.fail("expected interrupted runtime event");
  }
  const ref = continuationRefFromInterruptedEvent(decoded.event);
  if (!ref.ok) expect.fail("expected continuation ref");
  return ref.ref;
};

describe("runtime continuation projection", () => {
  it("reconstructs pending, approved, and consumed continuation state from ledger facts", () => {
    const pendingEvents = continuationEvents();
    const ref = refFrom(pendingEvents);

    expect(projectContinuationRefs(pendingEvents, 1)).toEqual([ref]);
    expect(projectContinuation(pendingEvents, ref)).toMatchObject({
      status: "pending",
      ref,
    });

    const approvedEvents: ReadonlyArray<LedgerEvent> = [
      ...pendingEvents,
      {
        id: 4,
        ts: 40,
        kind: DECISION_GATE_KIND.DECIDED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          decisionRef: "decision/1",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      },
    ];
    expect(projectContinuation(approvedEvents, ref)).toMatchObject({
      status: "approved",
      ref,
      decision: { decisionRef: "decision/1" },
      decisionEventId: 4,
    });
    expect(
      submitResumeDecisionFromContinuationProjection(projectContinuation(approvedEvents, ref), {
        approved: true,
      }),
    ).toEqual({
      ok: true,
      resume: {
        runId: 1,
        turn: { id: 1, index: 0 },
        interruptId: "decision:publish",
        gateRef: "decision_gate:publish",
        decisionRef: "decision/1",
        resume: { approved: true },
      },
    });

    const consumedEvents: ReadonlyArray<LedgerEvent> = [
      ...approvedEvents,
      {
        id: 5,
        ts: 50,
        kind: DECISION_GATE_KIND.CONSUMED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          decisionRef: "decision/1",
          consumedBy: "agent.run:1",
          claim: settleDecisionGateConsumed(decisionClaim, {
            gateRef: "decision_gate:publish",
            eventId: 4,
          }),
        },
      },
    ];
    expect(projectContinuation(consumedEvents, ref)).toMatchObject({
      status: "consumed",
      ref,
      consumed: { decisionRef: "decision/1" },
      consumedEventId: 5,
    });
    expect(
      submitResumeDecisionFromContinuationProjection(projectContinuation(consumedEvents, ref), {
        approved: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: "continuation_consumed",
    });
  });

  it("does not treat a mismatched serialized ref as a live continuation", () => {
    const events = continuationEvents();
    const ref = refFrom(events);
    expect(
      projectContinuation(events, {
        ...ref,
        interruptionEventId: ref.interruptionEventId + 1,
        afterEventId: ref.afterEventId + 1,
      }),
    ).toEqual({
      status: "missing_interruption",
      ref: {
        ...ref,
        interruptionEventId: ref.interruptionEventId + 1,
        afterEventId: ref.afterEventId + 1,
      },
    });
  });
});
