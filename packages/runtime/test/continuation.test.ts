import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { DECISION_GATE_KIND, settleDecisionGateConsumed } from "@agent-os/decision-gate";
import {
  agentRunInterruptedEvent,
  agentRunStartedEvent,
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent,
  type FailureDiagnostic,
  type RecoveryAttemptRecord,
  type RecoveryBudget,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";
import {
  fingerprintFailureDiagnostic,
  projectContinuation,
  projectContinuationRefs,
  projectRecoveryAttemptBudget,
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

  it("derives substrate recovery fingerprints from redacted failure diagnostics", () => {
    const diagnostic: FailureDiagnostic = {
      source: "tool",
      eventId: 7,
      phase: "decode",
      reason: "invalid_args",
      category: "invalid_args",
      owner: "model",
      retryable: true,
      publicMessage: "Tool arguments did not match the tool schema.",
      internalFacts: {
        source: "tool",
        eventId: 7,
        phase: "decode",
        reason: "invalid_args",
        toolName: "write_file",
      },
      toolName: "write_file",
    };

    expect(fingerprintFailureDiagnostic(diagnostic)).toEqual({
      owner: "agentos",
      value: "failure:invalid_args:invalid_args:write_file:decode",
    });
  });

  it("projects durable recovery hard budgets without trusting product fingerprints", () => {
    const budget: RecoveryBudget = { hard: { maxAttempts: 2, deadlineTs: 500 } };
    const attempts: ReadonlyArray<RecoveryAttemptRecord> = [
      {
        eventId: 10,
        ts: 100,
        cause: {
          kind: "recovery_verdict",
          verdictRef: "verdict/product/1",
          verdict: "recoverable",
          observation: { publicMessage: "Fragment contract failed." },
          fingerprint: { owner: "product", value: "line-1" },
        },
      },
      {
        eventId: 11,
        ts: 200,
        cause: {
          kind: "recovery_verdict",
          verdictRef: "verdict/product/2",
          verdict: "recoverable",
          observation: { publicMessage: "Fragment contract failed again." },
          fingerprint: { owner: "product", value: "line-2" },
        },
      },
    ];

    expect(projectRecoveryAttemptBudget(attempts, budget, 250)).toEqual({
      status: "terminal",
      attempts: 2,
      deadlineTs: 500,
      terminal: {
        kind: "attempt_budget_exhausted",
        attempts: 2,
        maxAttempts: 2,
      },
    });
  });

  it("uses product fingerprints only as a soft same-failure stop", () => {
    const budget: RecoveryBudget = {
      hard: { maxAttempts: 5 },
      soft: { maxSameFailure: 2 },
    };
    const attempts: ReadonlyArray<RecoveryAttemptRecord> = [
      {
        eventId: 10,
        ts: 100,
        cause: {
          kind: "recovery_verdict",
          verdictRef: "verdict/product/1",
          verdict: "recoverable",
          observation: { publicMessage: "Fragment contract failed." },
          fingerprint: { owner: "product", value: "zeroy-fragment:php-in-html" },
        },
      },
      {
        eventId: 11,
        ts: 200,
        cause: {
          kind: "recovery_verdict",
          verdictRef: "verdict/product/2",
          verdict: "recoverable",
          observation: { publicMessage: "Fragment contract failed again." },
          fingerprint: { owner: "product", value: "zeroy-fragment:php-in-html" },
        },
      },
    ];

    expect(projectRecoveryAttemptBudget(attempts, budget, 250)).toEqual({
      status: "terminal",
      attempts: 2,
      terminal: {
        kind: "same_failure_budget_exhausted",
        fingerprint: { owner: "product", value: "zeroy-fragment:php-in-html" },
        sameFailureCount: 2,
        maxSameFailure: 2,
      },
    });
  });

  it("projects durable deadline and terminal verdict causes", () => {
    expect(
      projectRecoveryAttemptBudget([], { hard: { maxAttempts: 3, deadlineTs: 300 } }, 300),
    ).toEqual({
      status: "terminal",
      attempts: 0,
      deadlineTs: 300,
      terminal: {
        kind: "deadline_exhausted",
        nowTs: 300,
        deadlineTs: 300,
      },
    });

    const attempts: ReadonlyArray<RecoveryAttemptRecord> = [
      {
        eventId: 10,
        ts: 100,
        cause: {
          kind: "recovery_verdict",
          verdictRef: "verdict/product/terminal",
          verdict: "terminal",
          observation: { publicMessage: "Fragment cannot satisfy the contract." },
        },
      },
    ];
    expect(projectRecoveryAttemptBudget(attempts, { hard: { maxAttempts: 3 } }, 150)).toEqual({
      status: "terminal",
      attempts: 1,
      terminal: {
        kind: "verdict_terminal",
        verdictRef: "verdict/product/terminal",
      },
    });
  });
});
