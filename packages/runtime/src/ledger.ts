import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/kernel/types";

export type LedgerCommitEventSpec = {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scope: string;
};

export class Ledger extends Context.Tag("@agent-os/Ledger")<
  Ledger,
  {
    readonly commit: (
      events: ReadonlyArray<LedgerCommitEventSpec>,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError | JsonStringifyError>;
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
