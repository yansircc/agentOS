import { Context, Effect } from "effect";
import {
  DurableTriggerDrainLimitExceeded,
  UnregisteredDurableTriggerKind,
  type JsonStringifyError,
  type SqlError,
} from "@agent-os/kernel";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/kernel/types";

export interface TriggerEventSpec {
  readonly kind: string;
  readonly payload: unknown;
  readonly ts?: number;
}

export interface TriggerIntentSpec {
  readonly triggerKind: string;
  readonly intentEventKind: string;
  readonly payload: unknown;
  readonly fireAt: number;
  readonly ts?: number;
}

export interface AcquireCtx {
  readonly scope: string;
  readonly now: number;
  readonly dueWorkId: number;
  readonly intentEventId: number;
}

export type TriggerParseResult<Intent> =
  | { readonly ok: true; readonly intent: Intent }
  | { readonly ok: false; readonly reason: string };

export const triggerParseOk = <Intent>(intent: Intent): TriggerParseResult<Intent> => ({
  ok: true,
  intent,
});

export const triggerParseFail = <Intent = never>(reason: string): TriggerParseResult<Intent> => ({
  ok: false,
  reason,
});

export interface TriggerTx extends AcquireCtx {
  readonly events: (
    opts?: Pick<EventQueryOptions, "afterId" | "kinds">,
  ) => ReadonlyArray<LedgerEvent>;
  readonly insertEvent: (spec: TriggerEventSpec) => LedgerEvent;
  readonly enqueue: (spec: TriggerIntentSpec) => LedgerEvent;
  readonly reschedule: (fireAt: number, intentEventId?: number) => void;
}

export interface DurableTrigger<Intent, Outcome, R = never> {
  readonly kind: string;
  readonly intentEventKind: string;
  readonly parseIntent: (raw: unknown) => TriggerParseResult<Intent>;
  // External acquire effects must be idempotent: another drain can complete the
  // same due row before this trigger reaches commit.
  readonly acquire: (intent: Intent, ctx: AcquireCtx) => Effect.Effect<Outcome, never, R>;
  readonly commit: (outcome: Outcome, tx: TriggerTx) => void;
}

// Heterogeneous registries erase the trigger-local intent/outcome types.
// Runtime safety is owned by each trigger's parseIntent before acquire runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDurableTrigger = DurableTrigger<any, any, never>;

export type TriggerRegistry = ReadonlyMap<string, AnyDurableTrigger>;

export class DurableTriggerRegistry extends Context.Tag("@agent-os/DurableTriggerRegistry")<
  DurableTriggerRegistry,
  TriggerRegistry
>() {}

export const getDurableTrigger = (
  registry: TriggerRegistry,
  kind: string,
): Effect.Effect<AnyDurableTrigger, UnregisteredDurableTriggerKind> => {
  const trigger = registry.get(kind);
  return trigger === undefined
    ? Effect.fail(new UnregisteredDurableTriggerKind({ kind }))
    : Effect.succeed(trigger);
};

export const DURABLE_TRIGGER_SCHEDULED_REQUESTED = "durable_trigger.scheduled.requested";

export interface ScheduledEventIntentPayload {
  readonly eventKind: string;
  readonly data: unknown;
}

export const scheduledEventIntentPayload = (
  eventKind: string,
  data: unknown,
): ScheduledEventIntentPayload => ({ eventKind, data });

export const parseScheduledEventIntentPayload = (
  raw: unknown,
): TriggerParseResult<ScheduledEventIntentPayload> => {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { readonly eventKind?: unknown }).eventKind !== "string"
  ) {
    return triggerParseFail("scheduled event intent payload malformed");
  }
  return triggerParseOk({
    eventKind: (raw as { readonly eventKind: string }).eventKind,
    data: (raw as { readonly data?: unknown }).data,
  });
};

export const scheduledEventTrigger = {
  kind: "scheduled_event",
  intentEventKind: DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  parseIntent: parseScheduledEventIntentPayload,
  acquire: (intent: ScheduledEventIntentPayload, _ctx: AcquireCtx) => Effect.succeed(intent),
  commit: (outcome, tx) => {
    tx.insertEvent({
      kind: outcome.eventKind,
      payload: outcome.data,
    });
  },
} satisfies DurableTrigger<ScheduledEventIntentPayload, ScheduledEventIntentPayload>;

export const makeDurableTriggerRegistry = (
  triggers: Iterable<AnyDurableTrigger>,
): Effect.Effect<TriggerRegistry, string> =>
  Effect.gen(function* () {
    const registry = new Map<string, AnyDurableTrigger>();
    for (const trigger of triggers) {
      if (registry.has(trigger.kind)) {
        return yield* Effect.fail(`duplicate durable trigger kind: ${trigger.kind}`);
      }
      registry.set(trigger.kind, trigger);
    }
    return registry;
  });

export interface TriggerDrainResult {
  readonly drained: number;
}

export interface TriggerDrainUntilQuietOptions {
  readonly maxIterations?: number;
}

export interface TriggerDrainUntilQuietResult {
  readonly drained: number;
  readonly iterations: number;
}

export const DEFAULT_TRIGGER_DRAIN_MAX_ITERATIONS = 32;

export const drainTriggerPumpUntilQuiet = <E>(
  drainDue: (now: number) => Effect.Effect<TriggerDrainResult, E>,
  now: number,
  options: TriggerDrainUntilQuietOptions = {},
): Effect.Effect<TriggerDrainUntilQuietResult, DurableTriggerDrainLimitExceeded | E> =>
  Effect.gen(function* () {
    const maxIterations = options.maxIterations ?? DEFAULT_TRIGGER_DRAIN_MAX_ITERATIONS;
    let drained = 0;
    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      const result = yield* drainDue(now);
      if (result.drained === 0) {
        return { drained, iterations: iteration };
      }
      drained += result.drained;
    }
    return yield* Effect.fail(new DurableTriggerDrainLimitExceeded({ maxIterations, drained }));
  });

export class TriggerPump extends Context.Tag("@agent-os/TriggerPump")<
  TriggerPump,
  {
    readonly drainDue: (
      now: number,
    ) => Effect.Effect<
      TriggerDrainResult,
      SqlError | JsonStringifyError | UnregisteredDurableTriggerKind
    >;
    readonly drainUntilQuiet: (
      now: number,
      options?: TriggerDrainUntilQuietOptions,
    ) => Effect.Effect<
      TriggerDrainUntilQuietResult,
      | SqlError
      | JsonStringifyError
      | UnregisteredDurableTriggerKind
      | DurableTriggerDrainLimitExceeded
    >;
  }
>() {}
