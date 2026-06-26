import type { AuthorityRef, ScopeRef } from "@agent-os/core/effect-claim";
import type { TraceContext } from "@agent-os/core/telemetry-protocol";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  decodeRuntimeLedgerEvent,
  decodeSubmitResult,
  RUNTIME_EVENT_KIND,
  scheduleFireDispatchedEvent,
  scheduleFireFailedEvent,
  scheduleFireRequestedEvent,
  type RuntimeEventCommitSpecByKind,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
  type ScheduleFireFailedPayload,
  type ScheduleFireProductLink,
  type SubmitResult,
  type SubmitRunInput,
} from "@agent-os/core/runtime-protocol";
import {
  projectAgentSession,
  projectWorkflowRun,
  type AgentSessionProjection,
  type AgentSessionTurnProjection,
  type WorkflowRunProjection,
} from "../run-projector";

const CRON_FIELD_PATTERN = /^[0-9*,/-]+$/u;
const SCHEDULED_MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/u;

declare const CronMinuteExpressionBrand: unique symbol;
declare const ScheduledMinuteBrand: unique symbol;

export type CronMinuteExpression = string & {
  readonly [CronMinuteExpressionBrand]: "CronMinuteExpression";
};

export type ScheduledMinute = string & {
  readonly [ScheduledMinuteBrand]: "ScheduledMinute";
};

export type SchedulePrincipal = Readonly<{
  authority: string;
  subject: string;
  claims?: Readonly<Record<string, unknown>>;
}>;

export interface ScheduleSessionSubmitTurnInput extends SubmitRunInput {
  readonly sessionRef: string;
  readonly turnRef: string;
  readonly idempotencyKey?: string;
}

export interface ScheduleWorkflowRunInput extends SubmitRunInput {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
}

export type ScheduleSessions = Readonly<{
  submitTurn(input: ScheduleSessionSubmitTurnInput): Promise<SubmitResult>;
}>;

export type ScheduleWorkflows = Readonly<{
  run(input: ScheduleWorkflowRunInput): Promise<SubmitResult>;
}>;

export type ScheduleRuntime = Readonly<{
  sessions: ScheduleSessions;
  workflows: ScheduleWorkflows;
}>;

export type ScheduleContext = Readonly<{
  appPrincipal: SchedulePrincipal;
  fireId: string;
  scheduledAt: ScheduledMinute;
  sessions: ScheduleSessions;
  workflows: ScheduleWorkflows;
}>;

export type ScheduleHandler<TResult = unknown> = (
  context: ScheduleContext,
) => TResult | Promise<TResult>;

export type DefinedSchedule<TResult = unknown> = Readonly<{
  cron: CronMinuteExpression;
  handler: ScheduleHandler<TResult>;
}>;

export type ScheduleDefinition<TResult = unknown> = Readonly<{
  cron: string;
  handler: ScheduleHandler<TResult>;
}>;

export type ScheduleContextSpec = Readonly<{
  appPrincipal: SchedulePrincipal;
  fireId: string;
  scheduledAt: string | number | Date;
}>;

export type ScheduleFireIdentitySpec = Readonly<{
  appPrincipal: SchedulePrincipal;
  scheduleId: string;
  scheduledAt: string | number | Date;
}>;

export type ScheduleFireDispatchInput<TResult = unknown> = Readonly<{
  runtime: ScheduleRuntime;
  schedule: DefinedSchedule<TResult>;
  scheduleId: string;
  scheduledAt: string | number | Date;
  appPrincipal: SchedulePrincipal;
  scopeRef: ScopeRef;
  effectAuthorityRef: AuthorityRef;
  traceContext?: TraceContext;
}>;

export type ScheduleFireRequestedEventSpec = RuntimeEventCommitSpecByKind<
  typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED
>;

export type ScheduleFireDispatchedEventSpec = RuntimeEventCommitSpecByKind<
  typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED
>;

export type ScheduleFireFailedEventSpec = RuntimeEventCommitSpecByKind<
  typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED
>;

export type ScheduleFireDispatchResult =
  | Readonly<{
      ok: true;
      fireId: string;
      requested: ScheduleFireRequestedEventSpec;
      outcome: (requestedEventId: number) => ScheduleFireDispatchedEventSpec;
      productLink: ScheduleFireProductLink;
    }>
  | Readonly<{
      ok: false;
      fireId: string;
      requested: ScheduleFireRequestedEventSpec;
      outcome: (requestedEventId: number) => ScheduleFireFailedEventSpec;
      phase: ScheduleFireFailedPayload["phase"];
      reason: string;
    }>;

export type ScheduleDefinitionProjection = Readonly<{
  scheduleId: string;
  path: string;
  cron: CronMinuteExpression | string;
}>;

export type ScheduleFireStatus = "requested" | "dispatched" | "failed";

export type ScheduleFireSessionProductProjection = Readonly<{
  kind: "session_turn";
  link: Extract<ScheduleFireProductLink, { readonly kind: "session_turn" }>;
  session: AgentSessionProjection;
  turn: AgentSessionTurnProjection | null;
}>;

export type ScheduleFireWorkflowProductProjection = Readonly<{
  kind: "workflow_run";
  link: Extract<ScheduleFireProductLink, { readonly kind: "workflow_run" }>;
  workflowRun: WorkflowRunProjection | null;
}>;

export type ScheduleFireProductProjection =
  | ScheduleFireSessionProductProjection
  | ScheduleFireWorkflowProductProjection;

export type ScheduleFireBaseProjection = Readonly<{
  scheduleId: string;
  fireId: string;
  scheduledAt: ScheduledMinute | string;
  requestedEventId: number;
  requestedAt: number;
  appPrincipal: SchedulePrincipal;
}>;

export type ScheduleFireProjection =
  | (ScheduleFireBaseProjection & {
      readonly status: "requested";
    })
  | (ScheduleFireBaseProjection & {
      readonly status: "dispatched";
      readonly outcomeEventId: number;
      readonly outcomeAt: number;
      readonly productLink: ScheduleFireProductLink;
      readonly product: ScheduleFireProductProjection;
    })
  | (ScheduleFireBaseProjection & {
      readonly status: "failed";
      readonly outcomeEventId: number;
      readonly outcomeAt: number;
      readonly phase: ScheduleFireFailedPayload["phase"];
      readonly reason: string;
    });

export type ScheduleFireHistorySpec = Readonly<{
  scheduleId?: string;
}>;

export type ScheduleFireHistoryProjection = Readonly<{
  scheduleId?: string;
  fires: ReadonlyArray<ScheduleFireProjection>;
}>;

export const cronMinuteExpression = (value: string): CronMinuteExpression => {
  if (typeof value !== "string") {
    return failScheduleContract("Schedule cron must be a string");
  }
  const fields = value.trim().split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
    return failScheduleContract("Schedule cron must have exactly five fields");
  }
  for (const field of fields) {
    if (!CRON_FIELD_PATTERN.test(field)) {
      return failScheduleContract(`Schedule cron field contains unsupported syntax: ${field}`);
    }
  }
  return fields.join(" ") as CronMinuteExpression;
};

export const scheduledMinute = (value: string | number | Date): ScheduledMinute => {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === "number"
        ? new Date(value)
        : parseScheduledMinuteString(value);
  if (!Number.isFinite(date.getTime())) {
    return failScheduleContract("Schedule scheduledAt must be a valid timestamp");
  }
  date.setUTCSeconds(0, 0);
  const normalized = date.toISOString();
  if (!SCHEDULED_MINUTE_PATTERN.test(normalized)) {
    return failScheduleContract("Schedule scheduledAt must normalize to a UTC minute");
  }
  return normalized as ScheduledMinute;
};

export const scheduleFireId = (spec: ScheduleFireIdentitySpec): string => {
  const principal = normalizePrincipal(spec.appPrincipal);
  const scheduleId = nonEmptyString(spec.scheduleId)
    ? spec.scheduleId
    : failScheduleContract("Schedule fire identity requires scheduleId");
  const minute = scheduledMinute(spec.scheduledAt);
  return [
    "schedule-fire",
    encodeURIComponent(principal.authority),
    encodeURIComponent(principal.subject),
    encodeURIComponent(scheduleId),
    encodeURIComponent(minute),
  ].join(":");
};

export const defineSchedule = <TResult = unknown>(
  spec: ScheduleDefinition<TResult>,
): DefinedSchedule<TResult> => {
  if (!isRecord(spec)) {
    return failScheduleContract("defineSchedule requires a schedule object");
  }
  if (typeof spec.handler !== "function") {
    return failScheduleContract("defineSchedule requires a handler");
  }
  return Object.freeze({
    cron: cronMinuteExpression(spec.cron),
    handler: spec.handler,
  });
};

export const createScheduleContext = (
  runtime: ScheduleRuntime,
  spec: ScheduleContextSpec,
): ScheduleContext => {
  assertScheduleRuntime(runtime);
  const appPrincipal = normalizePrincipal(spec.appPrincipal);
  const fireId = nonEmptyString(spec.fireId)
    ? spec.fireId
    : failScheduleContract("Schedule context requires fireId");
  return Object.freeze({
    appPrincipal,
    fireId,
    scheduledAt: scheduledMinute(spec.scheduledAt),
    sessions: Object.freeze({ submitTurn: runtime.sessions.submitTurn }),
    workflows: Object.freeze({ run: runtime.workflows.run }),
  });
};

export const dispatchScheduleFire = async <TResult = unknown>(
  input: ScheduleFireDispatchInput<TResult>,
): Promise<ScheduleFireDispatchResult> => {
  assertScheduleRuntime(input.runtime);
  assertDefinedSchedule(input.schedule);
  const appPrincipal = normalizePrincipal(input.appPrincipal);
  const scheduleId = nonEmptyString(input.scheduleId)
    ? input.scheduleId
    : failScheduleContract("Schedule dispatch requires scheduleId");
  const scheduledAt = scheduledMinute(input.scheduledAt);
  const fireId = scheduleFireId({ appPrincipal, scheduleId, scheduledAt });
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
      scheduleFireFailedEvent({
        ...base,
        requestedEventId,
        phase,
        reason,
      }),
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
          result = await input.runtime.sessions.submitTurn({
            ...submitInput,
            idempotencyKey,
          });
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
          result = await input.runtime.workflows.run({
            ...runInput,
            idempotencyKey,
          });
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
      createScheduleContext(normalizedRuntime, { appPrincipal, fireId, scheduledAt }),
    );
  } catch (cause) {
    if (cause instanceof ScheduleFireDispatchFailure) {
      return failed(cause.phase, cause.reason);
    }
    return failed("handler", "schedule_fire_handler_failed");
  }

  if (firstFailure !== undefined) {
    return failed(firstFailure.phase, firstFailure.reason);
  }
  if (productLink === undefined) {
    return failed("contract", "schedule_fire_product_ingress_missing");
  }
  const dispatchedProductLink = productLink;
  return {
    ok: true,
    fireId,
    requested,
    productLink: dispatchedProductLink,
    outcome: (requestedEventId) =>
      scheduleFireDispatchedEvent({
        ...base,
        requestedEventId,
        productLink: dispatchedProductLink,
      }),
  };
};

export const projectScheduleFireHistory = (
  events: ReadonlyArray<LedgerEvent>,
  spec: ScheduleFireHistorySpec = {},
): ScheduleFireHistoryProjection => {
  const runtimeEvents = [...scheduleRuntimeEventsOf(events)].sort(
    (left, right) => left.id - right.id,
  );
  const outcomes = new Map<number, ScheduleFireOutcomeEvent>();
  for (const event of runtimeEvents) {
    if (isScheduleFireOutcomeEvent(event)) {
      outcomes.set(event.payload.requestedEventId, event);
    }
  }
  const fires = runtimeEvents
    .filter(
      (event): event is ScheduleFireRequestedEvent =>
        event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED &&
        (spec.scheduleId === undefined || event.payload.scheduleId === spec.scheduleId),
    )
    .map((event) => scheduleFireProjectionFromEvent(events, event, outcomes.get(event.id)))
    .sort((left, right) => right.requestedEventId - left.requestedEventId);

  return {
    ...(spec.scheduleId === undefined ? {} : { scheduleId: spec.scheduleId }),
    fires,
  };
};

const parseScheduledMinuteString = (value: string): Date => {
  if (typeof value !== "string" || value.length === 0) {
    return failScheduleContract("Schedule scheduledAt must be a valid timestamp");
  }
  return new Date(value);
};

const assertScheduleRuntime = (runtime: ScheduleRuntime): void => {
  if (!isRecord(runtime)) {
    failScheduleContract("Schedule runtime must be an object");
  }
  if (!isRecord(runtime.sessions) || typeof runtime.sessions.submitTurn !== "function") {
    failScheduleContract("Schedule runtime requires sessions.submitTurn");
  }
  if (!isRecord(runtime.workflows) || typeof runtime.workflows.run !== "function") {
    failScheduleContract("Schedule runtime requires workflows.run");
  }
};

class ScheduleFireDispatchFailure extends Error {
  constructor(
    readonly phase: ScheduleFireFailedPayload["phase"],
    readonly reason: string,
  ) {
    super(reason);
  }
}

const assertDefinedSchedule = (schedule: DefinedSchedule): void => {
  if (!isRecord(schedule) || typeof schedule.handler !== "function") {
    failScheduleContract("Schedule dispatch requires a defined schedule");
  }
};

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

const normalizePrincipal = (principal: SchedulePrincipal): SchedulePrincipal => {
  if (!isRecord(principal)) {
    return failScheduleContract("Schedule appPrincipal must be an object");
  }
  if (!nonEmptyString(principal.authority)) {
    return failScheduleContract("Schedule appPrincipal requires authority");
  }
  if (!nonEmptyString(principal.subject)) {
    return failScheduleContract("Schedule appPrincipal requires subject");
  }
  if (principal.claims !== undefined && !isRecord(principal.claims)) {
    return failScheduleContract("Schedule appPrincipal claims must be an object");
  }
  return Object.freeze({
    authority: principal.authority,
    subject: principal.subject,
    ...(principal.claims === undefined ? {} : { claims: Object.freeze({ ...principal.claims }) }),
  });
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const failScheduleContract = (message: string): never => {
  throw new TypeError(message);
};

type ScheduleFireRequestedEvent = RuntimeLedgerEventByKind<
  typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED
>;

type ScheduleFireOutcomeEvent =
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED>
  | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED>;

const scheduleRuntimeEventsOf = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<RuntimeLedgerEvent> => {
  const decoded: RuntimeLedgerEvent[] = [];
  for (const event of events) {
    const result = decodeRuntimeLedgerEvent(event);
    if (result._tag === "runtime") decoded.push(result.event);
  }
  return decoded;
};

const isScheduleFireOutcomeEvent = (event: RuntimeLedgerEvent): event is ScheduleFireOutcomeEvent =>
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED ||
  event.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED;

const scheduleProductProjection = (
  events: ReadonlyArray<LedgerEvent>,
  productLink: ScheduleFireProductLink,
): ScheduleFireProductProjection => {
  if (productLink.kind === "session_turn") {
    const session = projectAgentSession(events, productLink.sessionRef);
    return {
      kind: "session_turn",
      link: productLink,
      session,
      turn:
        session.turns.find(
          (turn) =>
            turn.runtimeRunId === productLink.runtimeRunId && turn.turnRef === productLink.turnRef,
        ) ?? null,
    };
  }
  return {
    kind: "workflow_run",
    link: productLink,
    workflowRun: projectWorkflowRun(events, productLink.workflowId, productLink.workflowRunId),
  };
};

const scheduleFireProjectionFromEvent = (
  events: ReadonlyArray<LedgerEvent>,
  requested: ScheduleFireRequestedEvent,
  outcome: ScheduleFireOutcomeEvent | undefined,
): ScheduleFireProjection => {
  const base: ScheduleFireBaseProjection = {
    scheduleId: requested.payload.scheduleId,
    fireId: requested.payload.fireId,
    scheduledAt: requested.payload.scheduledAt,
    requestedEventId: requested.id,
    requestedAt: requested.ts,
    appPrincipal: requested.payload.appPrincipal,
  };

  if (outcome === undefined) {
    return {
      ...base,
      status: "requested",
    };
  }

  if (outcome.kind === RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED) {
    return {
      ...base,
      status: "failed",
      outcomeEventId: outcome.id,
      outcomeAt: outcome.ts,
      phase: outcome.payload.phase,
      reason: outcome.payload.reason,
    };
  }

  return {
    ...base,
    status: "dispatched",
    outcomeEventId: outcome.id,
    outcomeAt: outcome.ts,
    productLink: outcome.payload.productLink,
    product: scheduleProductProjection(events, outcome.payload.productLink),
  };
};
