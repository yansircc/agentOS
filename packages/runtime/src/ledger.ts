import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/kernel/types";
import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";

export const RUNTIME_FACT_OWNER = "@agent-os/runtime" as const;

export interface LedgerTruthIdentity {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
}

export type LedgerCommitEventSpec = {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef?: never;
  readonly scope?: never;
};

export class Ledger extends Context.Tag("@agent-os/Ledger")<
  Ledger,
  {
    readonly commit: (
      events: ReadonlyArray<LedgerCommitEventSpec>,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError | JsonStringifyError>;
    readonly events: (
      identity: LedgerTruthIdentity,
      opts?: EventQueryOptions,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
    readonly streamSnapshot: (
      identity: LedgerTruthIdentity,
      opts?: Pick<EventQueryOptions, "afterId" | "kinds">,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
  }
>() {}
