import { Context, Effect } from "effect";
import type { JsonStringifyError, UnregisteredDurableTriggerKind } from "@agent-os/core/errors";
import type { RuntimeStorageError } from "./ledger";

export interface Scheduler {
  readonly schedule: (
    at: number,
    eventKind: string,
    data: unknown,
  ) => Effect.Effect<
    { id: number },
    RuntimeStorageError | JsonStringifyError | UnregisteredDurableTriggerKind
  >;
}

export const Scheduler: Context.Service<Scheduler, Scheduler> = Context.Service<
  Scheduler,
  Scheduler
>("@agent-os/Scheduler");
