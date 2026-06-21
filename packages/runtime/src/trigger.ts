import { Context, Effect } from "effect";
import {
  DurableTriggerAcquireCancelled,
  DurableTriggerCommitReturnedThenable,
  DurableTriggerDrainLimitExceeded,
  UnregisteredDurableTriggerKind,
  type JsonStringifyError,
} from "@agent-os/kernel";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/kernel/types";
import {
  DURABLE_TRIGGER_SCHEDULED_CANCELLED,
  DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  SCHEDULED_EVENT_TRIGGER_KIND,
  parseScheduledEventIntentPayload,
  type ScheduledEventIntentPayload,
} from "@agent-os/backend-protocol";
import type { RuntimeStorageError } from "./ledger";

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
  readonly signal: AbortSignal;
  readonly acquireMode: "normal" | "redrive";
  readonly events: (
    opts?: Pick<EventQueryOptions, "afterId" | "kinds">,
  ) => ReadonlyArray<LedgerEvent>;
}

export interface TriggerCancellation {
  readonly reason?: string;
  readonly requestedAt?: number;
}

export type DurableTriggerCancellationMode = "cooperative" | "ignored";

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

export interface TriggerTx {
  readonly scope: string;
  readonly now: number;
  readonly dueWorkId: number;
  readonly intentEventId: number;
  readonly acquireMode: "normal" | "redrive";
  readonly insertEvent: (spec: TriggerEventSpec) => LedgerEvent;
  readonly enqueue: (spec: TriggerIntentSpec) => LedgerEvent;
  readonly reschedule: (fireAt: number, intentEventId?: number) => void;
}

export interface DurableTrigger<Intent, Outcome, R = never> {
  readonly kind: string;
  readonly intentEventKind: string;
  readonly cancellation: DurableTriggerCancellationMode;
  readonly acquireDeadlineMs?: number;
  readonly parseIntent: (raw: unknown) => TriggerParseResult<Intent>;
  // External acquire effects must be idempotent: another drain can complete the
  // same due row before this trigger reaches commit.
  readonly acquire: (
    intent: Intent,
    ctx: AcquireCtx,
  ) => Effect.Effect<Outcome, DurableTriggerAcquireCancelled, R>;
  readonly commit: (outcome: Outcome, tx: TriggerTx) => void;
  readonly commitCancelled: (
    intent: Intent,
    cancellation: TriggerCancellation,
    tx: TriggerTx,
  ) => void;
}

// Heterogeneous registries erase the trigger-local intent/outcome types.
// Runtime safety is owned by each trigger's parseIntent before acquire runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDurableTrigger = DurableTrigger<any, any, never>;

export type TriggerRegistry = ReadonlyMap<string, AnyDurableTrigger>;

export class DurableTriggerRegistry extends Context.Service<
  DurableTriggerRegistry,
  TriggerRegistry
>()("@agent-os/DurableTriggerRegistry") {}

export const getDurableTrigger = (
  registry: TriggerRegistry,
  kind: string,
): Effect.Effect<AnyDurableTrigger, UnregisteredDurableTriggerKind> => {
  const trigger = registry.get(kind);
  return trigger === undefined
    ? Effect.fail(new UnregisteredDurableTriggerKind({ kind }))
    : Effect.succeed(trigger);
};

export const DEFAULT_TRIGGER_ACQUIRE_DEADLINE_MS = 60_000;

export const scheduledEventTrigger = {
  kind: SCHEDULED_EVENT_TRIGGER_KIND,
  intentEventKind: DURABLE_TRIGGER_SCHEDULED_REQUESTED,
  cancellation: "cooperative",
  parseIntent: (raw) => {
    const parsed = parseScheduledEventIntentPayload(raw);
    return parsed.ok ? triggerParseOk(parsed.payload) : triggerParseFail(parsed.cause.message);
  },
  acquire: (intent: ScheduledEventIntentPayload, _ctx: AcquireCtx) => Effect.succeed(intent),
  commit: (outcome, tx) => {
    tx.insertEvent({
      kind: outcome.eventKind,
      payload: outcome.data,
    });
  },
  commitCancelled: (_intent, cancellation, tx) => {
    tx.insertEvent({
      kind: DURABLE_TRIGGER_SCHEDULED_CANCELLED,
      payload: {
        intentEventId: tx.intentEventId,
        ...(cancellation.requestedAt === undefined
          ? {}
          : { requestedAt: cancellation.requestedAt }),
        ...(cancellation.reason === undefined ? {} : { reason: cancellation.reason }),
      },
    });
  },
} satisfies DurableTrigger<ScheduledEventIntentPayload, ScheduledEventIntentPayload>;

const requiredTriggerField = (
  trigger: AnyDurableTrigger,
): "cancellation" | "commitCancelled" | null => {
  if (trigger.cancellation !== "cooperative" && trigger.cancellation !== "ignored") {
    return "cancellation";
  }
  if (typeof trigger.commitCancelled !== "function") return "commitCancelled";
  return null;
};

export const makeDurableTriggerRegistry = (
  triggers: Iterable<AnyDurableTrigger>,
): Effect.Effect<TriggerRegistry, string> =>
  Effect.withSpan("agentos.runtime.trigger.make_registry")(
    Effect.gen(function* () {
      const registry = new Map<string, AnyDurableTrigger>();
      for (const trigger of triggers) {
        const missing = requiredTriggerField(trigger);
        if (missing !== null) {
          return yield* Effect.fail(`durable trigger ${trigger.kind} missing ${missing}`);
        }
        if (registry.has(trigger.kind)) {
          return yield* Effect.fail(`duplicate durable trigger kind: ${trigger.kind}`);
        }
        registry.set(trigger.kind, trigger);
      }
      return registry;
    }),
  );

const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  typeof (value as { readonly then?: unknown }).then === "function";

export const runSynchronousTriggerCommit = (
  scope: string,
  kind: string,
  commit: () => unknown,
): DurableTriggerCommitReturnedThenable | null => {
  const result = commit();
  return isThenable(result) ? new DurableTriggerCommitReturnedThenable({ scope, kind }) : null;
};

export interface TriggerDrainResult {
  readonly drained: number;
}

export interface TriggerCancelSpec {
  readonly triggerKind: string;
  readonly intentEventId: number;
  readonly reason?: string;
}

export type TriggerCancelResult =
  | { readonly status: "ignored" }
  | { readonly status: "cancelled"; readonly cancelled: number }
  | { readonly status: "requested"; readonly requested: number }
  | { readonly status: "not_found"; readonly cancelled: 0 }
  | { readonly status: "already_completed"; readonly cancelled: 0 };

export interface TriggerStuckRow {
  readonly dueWorkId: number;
  readonly triggerKind: string;
  readonly intentEventId: number;
  readonly claimDeadlineAt: number;
  readonly redriveCount: number;
}

export interface TriggerStuckResult {
  readonly stuck: ReadonlyArray<TriggerStuckRow>;
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
  Effect.withSpan("agentos.runtime.trigger.drain_until_quiet")(
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
    }),
  );

export class TriggerPump extends Context.Service<
  TriggerPump,
  {
    readonly drainDue: (
      now: number,
    ) => Effect.Effect<
      TriggerDrainResult,
      | RuntimeStorageError
      | JsonStringifyError
      | UnregisteredDurableTriggerKind
      | DurableTriggerCommitReturnedThenable
    >;
    readonly drainUntilQuiet: (
      now: number,
      options?: TriggerDrainUntilQuietOptions,
    ) => Effect.Effect<
      TriggerDrainUntilQuietResult,
      | RuntimeStorageError
      | JsonStringifyError
      | UnregisteredDurableTriggerKind
      | DurableTriggerCommitReturnedThenable
      | DurableTriggerDrainLimitExceeded
    >;
    readonly cancelTrigger: (
      spec: TriggerCancelSpec,
    ) => Effect.Effect<
      TriggerCancelResult,
      | RuntimeStorageError
      | JsonStringifyError
      | UnregisteredDurableTriggerKind
      | DurableTriggerCommitReturnedThenable
    >;
    readonly stuckTriggers: (now: number) => Effect.Effect<TriggerStuckResult, RuntimeStorageError>;
  }
>()("@agent-os/TriggerPump") {}
