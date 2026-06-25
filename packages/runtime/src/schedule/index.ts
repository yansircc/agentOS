import type { SubmitResult, SubmitRunInput } from "@agent-os/core/runtime-protocol";

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
