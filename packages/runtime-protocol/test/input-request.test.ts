import { describe, expect, it } from "@effect/vitest";
import type { Recorded } from "@agent-os/kernel";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  agentRunInterruptedEvent,
  decodeRuntimeLedgerEvent,
  INPUT_REQUEST_KIND,
  inputRequestRefFromInterruptedEvent,
  isInputRequestRef,
  parseInputRequestResumePayload,
  recordedInputRequestRefFromUnknown,
  submitResumeDecisionFromInputRequestRef,
  type InputRequestRef,
  type RuntimeEventCommitSpec,
} from "../src";

const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: "input-request-test" },
  effectAuthorityRef: { authorityClass: "test", authorityId: "input-request-test" },
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

const interrupted = (
  reason: string,
  decision: RuntimeEventCommitSpec["payload"] extends infer Payload
    ? Payload extends { readonly decision?: infer Decision }
      ? Decision | null
      : never
    : never = {
    gateRef: "decision_gate:tool",
    subjectRef: "tool:publish",
    toolCallId: "call-1",
    toolName: "publish",
  },
) =>
  ledgerEvent(
    2,
    agentRunInterruptedEvent({
      ...identity,
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "decision:tool",
      reason,
      resumeSchema: { type: "object" },
      tokensUsed: 7,
      ...(decision === null ? {} : { decision }),
    }),
  );

const requestFrom = (event: LedgerEvent) => {
  const decoded = decodeRuntimeLedgerEvent(event);
  if (decoded._tag !== "runtime" || decoded.event.kind !== "agent.run.interrupted") {
    expect.fail("expected interrupted runtime event");
  }
  return inputRequestRefFromInterruptedEvent(decoded.event);
};

describe("InputRequest protocol vocabulary", () => {
  it("derives request refs for approval, question, and authorization interruptions", () => {
    const cases = [
      ["approval_required", INPUT_REQUEST_KIND.APPROVAL],
      ["user_input_required", INPUT_REQUEST_KIND.QUESTION],
      ["authorization_required", INPUT_REQUEST_KIND.AUTHORIZATION],
    ] as const;

    for (const [reason, kind] of cases) {
      const result = requestFrom(interrupted(reason));
      expect(result).toMatchObject({
        ok: true,
        ref: {
          kind: "agent.run.input_request",
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "decision:tool",
          gateRef: "decision_gate:tool",
          requestKind: kind,
          interruptionEventId: 2,
        },
        descriptor: {
          kind,
          subjectRef: "tool:publish",
          toolCallId: "call-1",
          toolName: "publish",
        },
      });
      if (!result.ok) expect.fail("expected InputRequest ref");
      const recordedRef: Recorded<InputRequestRef> = result.ref;
      expect(recordedRef.value.requestKind).toBe(kind);
      expect(Object.prototype.propertyIsEnumerable.call(result.ref, "value")).toBe(false);
      const wire = JSON.parse(JSON.stringify(result.ref)) as unknown;
      expect(isInputRequestRef(wire)).toBe(true);
      const reparsed = recordedInputRequestRefFromUnknown(wire);
      if (reparsed === null) expect.fail("expected recorded InputRequest ref");
      expect(reparsed.value.requestKind).toBe(kind);
      expect(Object.prototype.propertyIsEnumerable.call(reparsed, "value")).toBe(false);
      expect(isInputRequestRef(result.ref)).toBe(true);
      expect(isInputRequestRef({ ...result.ref, turn: { id: 2, index: 0 } })).toBe(false);
      expect(
        recordedInputRequestRefFromUnknown({ ...result.ref, turn: { id: 2, index: 0 } }),
      ).toBeNull();
    }
  });

  it("does not derive a request ref without decision binding or supported reason", () => {
    expect(requestFrom(interrupted("approval_required", null))).toEqual({
      ok: false,
      reason: "input_request_missing_decision_binding",
    });
    expect(requestFrom(interrupted("app_specific_wait"))).toEqual({
      ok: false,
      reason: "input_request_unsupported_reason",
    });
  });

  it("parses only positive resume contracts for each request kind", () => {
    expect(
      parseInputRequestResumePayload("approval", { kind: "approval", approved: true }),
    ).toEqual({
      ok: true,
      resume: { kind: "approval", approved: true },
    });
    expect(
      parseInputRequestResumePayload("question", {
        kind: "question",
        answers: { site_style: "clean" },
      }),
    ).toEqual({
      ok: true,
      resume: { kind: "question", answers: { site_style: "clean" } },
    });
    expect(
      parseInputRequestResumePayload("authorization", {
        kind: "authorization",
        authorization: {
          kind: "material_ref",
          materialRef: { kind: "credential", ref: "oauth/github/install-1" },
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseInputRequestResumePayload("authorization", {
        kind: "authorization",
        authorization: {
          kind: "recorded_sealed",
          sealed: {
            kind: "recorded_sealed",
            ref: "sealed/oauth/github/install-1",
            codec: "aead",
            version: "v1",
          },
        },
      }),
    ).toMatchObject({
      ok: true,
      resume: {
        kind: "authorization",
        authorization: {
          kind: "recorded_sealed",
          sealed: {
            kind: "recorded_sealed",
            ref: "sealed/oauth/github/install-1",
          },
        },
      },
    });
    const parsed = parseInputRequestResumePayload("authorization", {
      kind: "authorization",
      authorization: {
        kind: "recorded_sealed",
        sealed: {
          kind: "recorded_sealed",
          ref: "sealed/oauth/github/install-1",
          codec: "aead",
          version: "v1",
        },
      },
    });
    if (!parsed.ok) expect.fail("expected recorded sealed authorization ref");
    if (parsed.resume.kind !== "authorization") {
      expect.fail("expected authorization resume");
    }
    if (parsed.resume.authorization.kind !== "recorded_sealed") {
      expect.fail("expected recorded sealed authorization grant");
    }
    expect(parsed.resume.authorization.sealed.value.codec).toBe("aead");
    expect(
      Object.prototype.propertyIsEnumerable.call(parsed.resume.authorization.sealed, "value"),
    ).toBe(false);
  });

  it("rejects naked token-shaped authorization resumes by construction", () => {
    expect(
      parseInputRequestResumePayload("authorization", {
        kind: "authorization",
        access_token: "secret",
      }),
    ).toEqual({ ok: false, reason: "input_request_authorization_ref_malformed" });
    expect(
      parseInputRequestResumePayload("authorization", {
        kind: "authorization",
        authorization: { kind: "token", accessToken: "secret" },
      }),
    ).toEqual({ ok: false, reason: "input_request_authorization_ref_malformed" });
  });

  it("lowers approved request refs to SubmitResumeDecision without adding capability fields", () => {
    const result = requestFrom(interrupted("approval_required"));
    if (!result.ok) expect.fail("expected InputRequest ref");

    expect(
      submitResumeDecisionFromInputRequestRef(result.ref, {
        decisionRef: "decision/1",
        resume: { kind: "approval", approved: true },
      }),
    ).toEqual({
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "decision:tool",
      gateRef: "decision_gate:tool",
      decisionRef: "decision/1",
      resume: { kind: "approval", approved: true },
    });
  });
});
