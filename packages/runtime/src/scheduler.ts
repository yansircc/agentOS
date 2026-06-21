import { Context, Effect } from "effect";
import type { JsonStringifyError, UnregisteredDurableTriggerKind } from "@agent-os/core/errors";
import type { RuntimeStorageError } from "./ledger";

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly schedule: (
      at: number,
      eventKind: string,
      data: unknown,
    ) => Effect.Effect<
      { id: number },
      RuntimeStorageError | JsonStringifyError | UnregisteredDurableTriggerKind
    >;
  }
>()("@agent-os/Scheduler") {}
