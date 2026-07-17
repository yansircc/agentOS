import {
  decodeSubmitResult,
  planIngressDelivery,
  scheduleFireDispatchedEvent,
  scheduleFireFailedEvent,
  scheduleFireRequestedEvent,
  type ScheduleFireFailedPayload,
  type ScheduleFireProductLink,
  type SubmitResult,
} from "@agent-os/core/runtime-protocol";
import type {
  DefinedSchedule,
  ScheduleContext,
  ScheduleContextSpec,
  ScheduleFireDeliveryDispatchInput,
  ScheduleFireDeliveryDispatchResult,
  ScheduleFireDispatchInput,
  ScheduleFireDispatchResult,
  ScheduleFireIdentitySpec,
  SchedulePrincipal,
  ScheduleRuntime,
  ScheduleSessionSubmitTurnInput,
  ScheduleWorkflowRunInput,
  ScheduledMinute,
} from "./index";

export interface ScheduleDispatchContract {
  readonly assertScheduleRuntime: (runtime: ScheduleRuntime) => void;
  readonly assertDefinedSchedule: (schedule: DefinedSchedule) => void;
  readonly normalizePrincipal: (principal: SchedulePrincipal) => SchedulePrincipal;
  readonly nonEmptyString: (value: unknown) => value is string;
  readonly failScheduleContract: (message: string) => never;
  readonly scheduledMinute: (value: string | number | Date) => ScheduledMinute;
  readonly scheduleFireId: (spec: ScheduleFireIdentitySpec) => string;
  readonly createScheduleContext: (
    runtime: ScheduleRuntime,
    spec: ScheduleContextSpec,
  ) => ScheduleContext;
}

class ScheduleFireDispatchFailure extends Error {
  constructor(
    readonly phase: ScheduleFireFailedPayload["phase"],
    readonly reason: string,
  ) {
    super(reason);
  }
}

const requiredFireIdempotencyKey = (
  idempotencyKey: string | undefined,
  fireId: string,
  fail: (phase: ScheduleFireFailedPayload["phase"], reason: string) => ScheduleFireDispatchFailure,
): string => {
  if (idempotencyKey === undefined) return fireId;
  if (idempotencyKey === fireId) return idempotencyKey;
  throw fail("contract", "schedule_fire_idempotency_key_mismatch");
};

const assertSingleProductIngress = (
  productLink: ScheduleFireProductLink | undefined,
  fail: (phase: ScheduleFireFailedPayload["phase"], reason: string) => ScheduleFireDispatchFailure,
): void => {
  if (productLink !== undefined) {
    throw fail("contract", "schedule_fire_multiple_product_ingress_calls");
  }
};

export const dispatchScheduleFireHost = async <TResult = unknown>(
  input: ScheduleFireDispatchInput<TResult>,
  contract: ScheduleDispatchContract,
): Promise<ScheduleFireDispatchResult> => {
  contract.assertScheduleRuntime(input.runtime);
  contract.assertDefinedSchedule(input.schedule);
  const appPrincipal = contract.normalizePrincipal(input.appPrincipal);
  const scheduleId = contract.nonEmptyString(input.scheduleId)
    ? input.scheduleId
    : contract.failScheduleContract("Schedule dispatch requires scheduleId");
  const scheduledAt = contract.scheduledMinute(input.scheduledAt);
  const fireId = contract.scheduleFireId({ appPrincipal, scheduleId, scheduledAt });
  const requested = scheduleFireRequestedEvent({
    scopeRef: input.scopeRef,
    effectAuthorityRef: input.effectAuthorityRef,
    scheduleId,
    fireId,
    scheduledAt,
    appPrincipal,
    ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  });
  const base = {
    scopeRef: input.scopeRef,
    effectAuthorityRef: input.effectAuthorityRef,
    scheduleId,
    fireId,
    scheduledAt,
    ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  };
  const failed = (
    phase: ScheduleFireFailedPayload["phase"],
    reason: string,
  ): ScheduleFireDispatchResult => ({
    ok: false,
    fireId,
    requested,
    phase,
    reason,
    outcome: (requestedEventId) =>
      scheduleFireFailedEvent({ ...base, requestedEventId, phase, reason }),
  });

  let productLink: ScheduleFireProductLink | undefined;
  let firstFailure: ScheduleFireDispatchFailure | undefined;
  const rememberFailure = (
    phase: ScheduleFireFailedPayload["phase"],
    reason: string,
  ): ScheduleFireDispatchFailure => {
    const failure = new ScheduleFireDispatchFailure(phase, reason);
    firstFailure ??= failure;
    return failure;
  };
  const normalizedRuntime: ScheduleRuntime = Object.freeze({
    sessions: Object.freeze({
      submitTurn: async (submitInput: ScheduleSessionSubmitTurnInput) => {
        const idempotencyKey = requiredFireIdempotencyKey(
          submitInput.idempotencyKey,
          fireId,
          rememberFailure,
        );
        assertSingleProductIngress(productLink, rememberFailure);
        let result: SubmitResult;
        try {
          result = await input.runtime.sessions.submitTurn({ ...submitInput, idempotencyKey });
        } catch {
          throw rememberFailure("product_ingress", "schedule_fire_product_ingress_failed");
        }
        const decoded = decodeSubmitResult(result);
        if (decoded === null) {
          throw rememberFailure("product_ingress", "schedule_fire_product_ingress_result_invalid");
        }
        productLink = {
          kind: "session_turn",
          sessionRef: submitInput.sessionRef,
          turnRef: submitInput.turnRef,
          runtimeRunId: decoded.runId,
          idempotencyKey,
        };
        return decoded;
      },
    }),
    workflows: Object.freeze({
      run: async (runInput: ScheduleWorkflowRunInput) => {
        const idempotencyKey = requiredFireIdempotencyKey(
          runInput.idempotencyKey,
          fireId,
          rememberFailure,
        );
        assertSingleProductIngress(productLink, rememberFailure);
        let result: SubmitResult;
        try {
          result = await input.runtime.workflows.run({ ...runInput, idempotencyKey });
        } catch {
          throw rememberFailure("product_ingress", "schedule_fire_product_ingress_failed");
        }
        const decoded = decodeSubmitResult(result);
        if (decoded === null) {
          throw rememberFailure("product_ingress", "schedule_fire_product_ingress_result_invalid");
        }
        productLink = {
          kind: "workflow_run",
          workflowId: runInput.workflowId,
          workflowRunId: runInput.workflowRunId,
          runtimeRunId: decoded.runId,
          idempotencyKey,
          ...(runInput.inputDigest === undefined ? {} : { inputDigest: runInput.inputDigest }),
        };
        return decoded;
      },
    }),
  });

  try {
    await input.schedule.handler(
      contract.createScheduleContext(normalizedRuntime, { appPrincipal, fireId, scheduledAt }),
    );
  } catch (cause) {
    if (cause instanceof ScheduleFireDispatchFailure) return failed(cause.phase, cause.reason);
    return failed("handler", "schedule_fire_handler_failed");
  }
  if (firstFailure !== undefined) return failed(firstFailure.phase, firstFailure.reason);
  if (productLink === undefined) return failed("contract", "schedule_fire_product_ingress_missing");
  const dispatchedProductLink = productLink;
  return {
    ok: true,
    fireId,
    requested,
    productLink: dispatchedProductLink,
    outcome: (requestedEventId) =>
      scheduleFireDispatchedEvent({ ...base, requestedEventId, productLink: dispatchedProductLink }),
  };
};

export const dispatchScheduleFireDeliveryHost = async <TResult = unknown>(
  input: ScheduleFireDeliveryDispatchInput<TResult>,
  contract: ScheduleDispatchContract,
): Promise<ScheduleFireDeliveryDispatchResult> => {
  const appPrincipal = contract.normalizePrincipal(input.appPrincipal);
  const scheduleId = contract.nonEmptyString(input.scheduleId)
    ? input.scheduleId
    : contract.failScheduleContract("Schedule dispatch requires scheduleId");
  const scheduledAt = contract.scheduledMinute(input.scheduledAt);
  const fireId = contract.scheduleFireId({ appPrincipal, scheduleId, scheduledAt });
  const delivery = planIngressDelivery({
    history: input.history,
    scopeRef: input.scopeRef,
    effectAuthorityRef: input.effectAuthorityRef,
    deliveryKey: fireId,
    slot: { kind: "schedule", id: scheduleId },
    principal: appPrincipal,
    ...(input.traceContext === undefined ? {} : { traceContext: input.traceContext }),
  });
  if (delivery.kind === "replay") return { kind: "replay", fireId, delivery, projection: delivery.projection };
  const schedule = await dispatchScheduleFireHost(
    { ...input, appPrincipal, scheduleId, scheduledAt },
    contract,
  );
  return { kind: "attempt", fireId, delivery, schedule };
};
