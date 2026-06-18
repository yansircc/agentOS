import { Predicate } from "effect";
import { isScopeRef } from "@agent-os/kernel/effect-claim";
import { isMaterialRef, type MaterialRef } from "@agent-os/kernel/material-ref";
import type { Recorded } from "@agent-os/kernel";
import type { LedgerWitnessedScopedRef } from "./continuation";
import type { RuntimeLedgerEventByKind } from "./runtime-events";
import { RUNTIME_EVENT_KIND } from "./runtime-events";
import type { SubmitResumeDecision, TurnRef } from "./submit";
import { recordRuntimeProtocolValue } from "./recorded";

export const INPUT_REQUEST_REF_KIND = "agent.run.input_request" as const;

export const INPUT_REQUEST_KIND = {
  APPROVAL: "approval",
  QUESTION: "question",
  AUTHORIZATION: "authorization",
} as const;

export type InputRequestKind = (typeof INPUT_REQUEST_KIND)[keyof typeof INPUT_REQUEST_KIND];

export const INPUT_REQUEST_REASON = {
  [INPUT_REQUEST_KIND.APPROVAL]: "approval_required",
  [INPUT_REQUEST_KIND.QUESTION]: "user_input_required",
  [INPUT_REQUEST_KIND.AUTHORIZATION]: "authorization_required",
} as const satisfies Record<InputRequestKind, string>;

export type InputRequestReason = (typeof INPUT_REQUEST_REASON)[InputRequestKind];

export interface InputRequestRef extends LedgerWitnessedScopedRef<typeof INPUT_REQUEST_REF_KIND> {
  readonly runId: number;
  readonly turn: TurnRef;
  readonly interruptId: string;
  readonly interruptionEventId: number;
  readonly gateRef: string;
  readonly requestKind: InputRequestKind;
}

export type RecordedInputRequestRef = InputRequestRef & Recorded<InputRequestRef>;

export interface InputRequestDescriptor {
  readonly ref: InputRequestRef;
  readonly kind: InputRequestKind;
  readonly subjectRef: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly policyRef?: string;
  readonly summary?: string;
  readonly resumeSchema: unknown;
}

export type InputRequestRefFromInterruptionResult =
  | {
      readonly ok: true;
      readonly ref: RecordedInputRequestRef;
      readonly descriptor: InputRequestDescriptor;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "input_request_missing_decision_binding"
        | "input_request_unsupported_reason";
    };

export interface InputRequestAnswer {
  readonly decisionRef: string;
  readonly resume: InputRequestResumePayload;
}

export type InputRequestResumePayload =
  | ApprovalInputRequestResumePayload
  | QuestionInputRequestResumePayload
  | AuthorizationInputRequestResumePayload;

export interface ApprovalInputRequestResumePayload {
  readonly kind: "approval";
  readonly approved: true;
}

export interface QuestionInputRequestResumePayload {
  readonly kind: "question";
  readonly answers: Readonly<Record<string, unknown>>;
}

export interface RecordedSealedAuthorizationRef {
  readonly kind: "recorded_sealed";
  readonly ref: string;
  readonly codec: "aead";
  readonly version: string;
}

export type ParsedRecordedSealedAuthorizationRef = RecordedSealedAuthorizationRef &
  Recorded<RecordedSealedAuthorizationRef>;

export type AuthorizationGrantRef =
  | {
      readonly kind: "material_ref";
      readonly materialRef: MaterialRef;
    }
  | {
      readonly kind: "recorded_sealed";
      readonly sealed: ParsedRecordedSealedAuthorizationRef;
    };

export interface AuthorizationInputRequestResumePayload {
  readonly kind: "authorization";
  readonly authorization: AuthorizationGrantRef;
}

export type ParseInputRequestResumeResult =
  | { readonly ok: true; readonly resume: InputRequestResumePayload }
  | {
      readonly ok: false;
      readonly reason:
        | "input_request_resume_kind_mismatch"
        | "input_request_resume_malformed"
        | "input_request_authorization_ref_malformed";
    };

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isTurnRef = (value: unknown): value is TurnRef =>
  Predicate.isObject(value) &&
  isPositiveInteger(value.id) &&
  typeof value.index === "number" &&
  Number.isInteger(value.index) &&
  value.index >= 0;

export const inputRequestKindFromReason = (reason: string): InputRequestKind | null => {
  switch (reason) {
    case INPUT_REQUEST_REASON.approval:
      return INPUT_REQUEST_KIND.APPROVAL;
    case INPUT_REQUEST_REASON.question:
      return INPUT_REQUEST_KIND.QUESTION;
    case INPUT_REQUEST_REASON.authorization:
      return INPUT_REQUEST_KIND.AUTHORIZATION;
    default:
      return null;
  }
};

export const isInputRequestRef = (value: unknown): value is InputRequestRef =>
  Predicate.isObject(value) &&
  value.kind === INPUT_REQUEST_REF_KIND &&
  isScopeRef(value.scopeRef) &&
  isPositiveInteger(value.afterEventId) &&
  isPositiveInteger(value.runId) &&
  isTurnRef(value.turn) &&
  isNonEmptyString(value.interruptId) &&
  isPositiveInteger(value.interruptionEventId) &&
  isNonEmptyString(value.gateRef) &&
  (value.requestKind === INPUT_REQUEST_KIND.APPROVAL ||
    value.requestKind === INPUT_REQUEST_KIND.QUESTION ||
    value.requestKind === INPUT_REQUEST_KIND.AUTHORIZATION);

export const recordedInputRequestRefFromUnknown = (
  value: unknown,
): RecordedInputRequestRef | null =>
  isInputRequestRef(value) ? recordRuntimeProtocolValue(value) : null;

export const inputRequestRefFromInterruptedEvent = (
  event: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED>,
): InputRequestRefFromInterruptionResult => {
  const decision = event.payload.decision;
  if (decision === undefined) {
    return { ok: false, reason: "input_request_missing_decision_binding" };
  }
  const requestKind = inputRequestKindFromReason(event.payload.reason);
  if (requestKind === null) {
    return { ok: false, reason: "input_request_unsupported_reason" };
  }
  const ref = recordRuntimeProtocolValue({
    kind: INPUT_REQUEST_REF_KIND,
    scopeRef: event.scopeRef,
    afterEventId: event.id,
    runId: event.payload.runId,
    turn: event.payload.turn,
    interruptId: event.payload.interruptId,
    interruptionEventId: event.id,
    gateRef: decision.gateRef,
    requestKind,
  } satisfies InputRequestRef);
  return {
    ok: true,
    ref,
    descriptor: {
      ref,
      kind: requestKind,
      subjectRef: decision.subjectRef,
      toolCallId: decision.toolCallId,
      toolName: decision.toolName,
      resumeSchema: event.payload.resumeSchema,
    },
  };
};

const isRecordedSealedAuthorizationRef = (
  value: unknown,
): value is RecordedSealedAuthorizationRef =>
  Predicate.isObject(value) &&
  value.kind === "recorded_sealed" &&
  isNonEmptyString(value.ref) &&
  value.codec === "aead" &&
  isNonEmptyString(value.version);

const parseAuthorizationGrantRef = (value: unknown): AuthorizationGrantRef | null => {
  if (!Predicate.isObject(value)) return null;
  if (value.kind === "material_ref" && isMaterialRef(value.materialRef)) {
    return { kind: "material_ref", materialRef: value.materialRef };
  }
  if (value.kind === "recorded_sealed" && isRecordedSealedAuthorizationRef(value.sealed)) {
    return { kind: "recorded_sealed", sealed: recordRuntimeProtocolValue(value.sealed) };
  }
  return null;
};

export const parseInputRequestResumePayload = (
  requestKind: InputRequestKind,
  value: unknown,
): ParseInputRequestResumeResult => {
  if (!Predicate.isObject(value)) return { ok: false, reason: "input_request_resume_malformed" };
  if (value.kind !== requestKind) {
    return { ok: false, reason: "input_request_resume_kind_mismatch" };
  }
  switch (requestKind) {
    case INPUT_REQUEST_KIND.APPROVAL:
      return value.approved === true
        ? { ok: true, resume: { kind: "approval", approved: true } }
        : { ok: false, reason: "input_request_resume_malformed" };
    case INPUT_REQUEST_KIND.QUESTION:
      return Predicate.isObject(value.answers)
        ? { ok: true, resume: { kind: "question", answers: value.answers } }
        : { ok: false, reason: "input_request_resume_malformed" };
    case INPUT_REQUEST_KIND.AUTHORIZATION: {
      const authorization = parseAuthorizationGrantRef(value.authorization);
      return authorization === null
        ? { ok: false, reason: "input_request_authorization_ref_malformed" }
        : { ok: true, resume: { kind: "authorization", authorization } };
    }
  }
};

export const submitResumeDecisionFromInputRequestRef = (
  ref: InputRequestRef,
  answer: InputRequestAnswer,
): SubmitResumeDecision => ({
  runId: ref.runId,
  turn: ref.turn,
  interruptId: ref.interruptId,
  gateRef: ref.gateRef,
  decisionRef: answer.decisionRef,
  resume: answer.resume,
});
