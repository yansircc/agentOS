import { Duration, Schedule } from "effect";
import type {
  SubmitToolExecutionRetryPolicy,
  SubmitToolRetryDelayPolicy,
  SubmitToolRetryPolicy,
} from "@agent-os/runtime-protocol";

export interface NormalizedSubmitToolRetryPolicy {
  readonly correctionRetries: number;
  readonly executionRetrySchedule: Schedule.Schedule<unknown, unknown, never>;
}

const DEFAULT_CORRECTION_RETRIES = 2;
const DEFAULT_EXECUTION_RETRIES = 2;

const DEFAULT_EXECUTION_DELAY = {
  kind: "exponential",
  baseDelayMs: 100,
  factor: 2,
  jitter: true,
} satisfies SubmitToolRetryDelayPolicy;

const nonNegativeIntegerOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;

const positiveMillisOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const positiveFactorOr = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 1 ? value : fallback;

const applyRetryLimit = (
  schedule: Schedule.Schedule<unknown, unknown, never>,
  maxRetries: number,
): Schedule.Schedule<unknown, unknown, never> =>
  schedule.pipe(Schedule.both(Schedule.recurs(maxRetries)));

export const executionRetryScheduleFromPolicy = (
  policy: SubmitToolExecutionRetryPolicy | undefined,
): Schedule.Schedule<unknown, unknown, never> => {
  const maxRetries = nonNegativeIntegerOr(policy?.maxRetries, DEFAULT_EXECUTION_RETRIES);
  const delay = policy?.delay ?? DEFAULT_EXECUTION_DELAY;

  if (delay.kind === "none") return Schedule.recurs(maxRetries);

  const delayed =
    delay.kind === "fixed"
      ? Schedule.spaced(Duration.millis(positiveMillisOr(delay.delayMs, 1)))
      : Schedule.exponential(
          Duration.millis(positiveMillisOr(delay.baseDelayMs, DEFAULT_EXECUTION_DELAY.baseDelayMs)),
          positiveFactorOr(delay.factor, DEFAULT_EXECUTION_DELAY.factor),
        );

  const bounded = applyRetryLimit(delayed, maxRetries);
  return delay.jitter === false ? bounded : bounded.pipe(Schedule.jittered);
};

export const normalizeSubmitToolRetryPolicy = (
  policy: SubmitToolRetryPolicy | undefined,
): NormalizedSubmitToolRetryPolicy => ({
  correctionRetries: nonNegativeIntegerOr(policy?.correctionRetries, DEFAULT_CORRECTION_RETRIES),
  executionRetrySchedule: executionRetryScheduleFromPolicy(policy?.execution),
});
