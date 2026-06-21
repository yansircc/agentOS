import type { Effect as EffectType } from "effect";
import type { DurableTriggerAcquireCancelled } from "@agent-os/kernel/errors";
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
  readonly acquire: (
    intent: Intent,
    ctx: AcquireCtx,
  ) => EffectType.Effect<Outcome, DurableTriggerAcquireCancelled, R>;
  readonly commit: (outcome: Outcome, tx: TriggerTx) => void;
  readonly commitCancelled: (
    intent: Intent,
    cancellation: TriggerCancellation,
    tx: TriggerTx,
  ) => void;
}

// Heterogeneous contract drivers erase trigger-local intent/outcome types.
// Runtime safety is owned by each trigger's parseIntent before acquire runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDurableTrigger = DurableTrigger<any, any, never>;
