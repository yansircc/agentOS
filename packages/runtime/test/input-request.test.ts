import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";
import { DECISION_GATE_KIND, settleDecisionGateConsumed } from "../src/decision-gate";
import {
  agentRunInterruptedEvent,
  agentRunStartedEvent,
  decodeRuntimeLedgerEvent,
  inputRequestRefFromInterruptedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/core/runtime-protocol";
import {
  projectInputRequest,
  projectInputRequests,
  submitResumeDecisionFromInputRequestProjection,
} from "../src/input-request";

const scope = "input-request-runtime-test";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};
const eventIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};
const claim = makePreClaim({
  operationRef: "decision_gate:input-request-runtime-test",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityClass: "decision", authorityId: scope },
  originRef: { originKind: "run", originId: "run:1" },
});

const event = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const requestedEvents = (reason = "approval_required"): ReadonlyArray<LedgerEvent> => [
  event(1, agentRunStartedEvent({ ...identity, intent: "publish" })),
  event(
    2,
    agentRunInterruptedEvent({
      ...identity,
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "decision:publish",
      reason,
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
      claim,
    },
  },
];

const refFrom = (events: ReadonlyArray<LedgerEvent>) => {
  const decoded = decodeRuntimeLedgerEvent(events[1]!);
  if (decoded._tag !== "runtime" || decoded.event.kind !== "agent.run.interrupted") {
    expect.fail("expected interrupted runtime event");
  }
  const ref = inputRequestRefFromInterruptedEvent(decoded.event);
  if (!ref.ok) expect.fail("expected input request ref");
  return ref.ref;
};

describe("runtime InputRequest projection", () => {
  it("reconstructs pending, approved, and consumed request state from ledger facts", () => {
    const pending = requestedEvents();
    const ref = refFrom(pending);

    expect(projectInputRequests(pending, 1)).toEqual([ref]);
    expect(projectInputRequest(pending, ref)).toMatchObject({
      status: "pending",
      ref,
      request: { kind: "approval", subjectRef: "tool:publish" },
    });

    const approved: ReadonlyArray<LedgerEvent> = [
      ...pending,
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
    expect(projectInputRequest(approved, ref)).toMatchObject({
      status: "approved",
      decision: { decisionRef: "decision/1" },
      decisionEventId: 4,
    });
    expect(
      submitResumeDecisionFromInputRequestProjection(projectInputRequest(approved, ref), {
        kind: "approval",
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
        resume: { kind: "approval", approved: true },
      },
    });

    const consumed: ReadonlyArray<LedgerEvent> = [
      ...approved,
      {
        id: 5,
        ts: 50,
        kind: DECISION_GATE_KIND.CONSUMED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          decisionRef: "decision/1",
          consumedBy: "agent.run:1",
          claim: settleDecisionGateConsumed(claim, {
            gateRef: "decision_gate:publish",
            eventId: 4,
          }),
        },
      },
    ];
    expect(projectInputRequest(consumed, ref)).toMatchObject({
      status: "consumed",
      consumedEventId: 5,
    });
    expect(
      submitResumeDecisionFromInputRequestProjection(projectInputRequest(consumed, ref), {
        kind: "approval",
        approved: true,
      }),
    ).toMatchObject({
      ok: false,
      reason: "input_request_consumed",
    });
  });

  it("does not accept a mismatched serialized ref as authority", () => {
    const events = requestedEvents();
    const ref = refFrom(events);
    expect(
      projectInputRequest(events, {
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

  it("requires positive resume shapes for question and authorization requests", () => {
    const questionEvents: ReadonlyArray<LedgerEvent> = [
      ...requestedEvents("user_input_required"),
      {
        id: 4,
        ts: 40,
        kind: DECISION_GATE_KIND.DECIDED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          decisionRef: "decision/answers",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      },
    ];
    const questionRef = refFrom(questionEvents);
    expect(
      submitResumeDecisionFromInputRequestProjection(
        projectInputRequest(questionEvents, questionRef),
        {
          kind: "question",
          answers: { site_style: "clean" },
        },
      ),
    ).toMatchObject({ ok: true });
    expect(
      submitResumeDecisionFromInputRequestProjection(
        projectInputRequest(questionEvents, questionRef),
        {
          kind: "authorization",
          authorization: {
            kind: "material_ref",
            materialRef: { kind: "credential", ref: "oauth/github/install-1" },
          },
        },
      ),
    ).toEqual({
      ok: false,
      reason: "input_request_resume_kind_mismatch",
      projection: projectInputRequest(questionEvents, questionRef),
    });

    const authEvents = requestedEvents("authorization_required");
    const approvedAuth: ReadonlyArray<LedgerEvent> = [
      ...authEvents,
      {
        id: 4,
        ts: 40,
        kind: DECISION_GATE_KIND.DECIDED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          decisionRef: "decision/auth",
          decision: "approved",
          decidedBy: "operator/alice",
        },
      },
    ];
    const authRef = refFrom(approvedAuth);
    expect(
      submitResumeDecisionFromInputRequestProjection(projectInputRequest(approvedAuth, authRef), {
        kind: "authorization",
        access_token: "secret",
      }),
    ).toMatchObject({
      ok: false,
      reason: "input_request_authorization_ref_malformed",
    });
    expect(
      submitResumeDecisionFromInputRequestProjection(projectInputRequest(approvedAuth, authRef), {
        kind: "authorization",
        authorization: {
          kind: "material_ref",
          materialRef: { kind: "credential", ref: "oauth/github/install-1" },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("projects non-resumable cancelled and expired gate closures", () => {
    const cancelledEvents: ReadonlyArray<LedgerEvent> = [
      ...requestedEvents(),
      {
        id: 4,
        ts: 40,
        kind: DECISION_GATE_KIND.CANCELLED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          closeRef: "cancel/1",
          reason: "operator_cancelled",
        },
      },
    ];
    const cancelledRef = refFrom(cancelledEvents);
    const cancelled = projectInputRequest(cancelledEvents, cancelledRef);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancelled: { closeRef: "cancel/1" },
    });
    expect(
      submitResumeDecisionFromInputRequestProjection(cancelled, {
        kind: "approval",
        approved: true,
      }),
    ).toEqual({
      ok: false,
      reason: "input_request_cancelled",
      projection: cancelled,
    });

    const expiredEvents: ReadonlyArray<LedgerEvent> = [
      ...requestedEvents(),
      {
        id: 4,
        ts: 40,
        kind: DECISION_GATE_KIND.EXPIRED,
        ...eventIdentity,
        payload: {
          gateRef: "decision_gate:publish",
          closeRef: "expire/1",
          reason: "deadline",
        },
      },
    ];
    expect(projectInputRequest(expiredEvents, refFrom(expiredEvents))).toMatchObject({
      status: "expired",
      expired: { closeRef: "expire/1" },
    });
  });
});
