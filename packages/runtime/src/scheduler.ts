import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";

export class Scheduler extends Context.Tag("@agent-os/Scheduler")<
  Scheduler,
  {
    readonly schedule: (
      at: number,
      eventKind: string,
      data: unknown,
    ) => Effect.Effect<{ id: number }, SqlError | JsonStringifyError>;
    readonly fireDue: (
      now: number,
    ) => Effect.Effect<{ fired: number }, SqlError | JsonStringifyError>;
  }
>() {}
