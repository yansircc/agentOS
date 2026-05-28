import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { EventQueryOptions, LedgerEvent } from "./types";

export class Ledger extends Context.Tag("@agent-os/Ledger")<
  Ledger,
  {
    readonly log: (
      kind: string,
      payload: unknown,
      scope: string,
    ) => Effect.Effect<LedgerEvent, SqlError | JsonStringifyError>;
    readonly events: (
      scope: string,
      opts?: EventQueryOptions,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
    readonly streamSnapshot: (
      scope: string,
      opts?: Pick<EventQueryOptions, "afterId" | "kinds">,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
  }
>() {}
