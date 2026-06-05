import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/kernel/types";
import type { AuthorityRef, ScopeRef } from "@agent-os/kernel/effect-claim";

export const RUNTIME_FACT_OWNER = "@agent-os/runtime" as const;

/**
 * Exact runtime ledger identity used by reads and streams.
 *
 * @agentosPrimitive primitive.runtime.LedgerTruthIdentity
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export interface LedgerTruthIdentity {
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
}

/**
 * Runtime-owned event commit spec; factOwnerRef is injected by the ledger service.
 *
 * @agentosPrimitive primitive.runtime.LedgerCommitEventSpec
 * @agentosInvariant invariant.ledger.single-commit-source
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export type LedgerCommitEventSpec = {
  readonly ts?: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly factOwnerRef?: never;
  readonly scope?: never;
};

/**
 * Backend-neutral ledger service for atomic fact commits and exact identity reads.
 *
 * @agentosPrimitive primitive.runtime.Ledger
 * @agentosInvariant invariant.ledger.single-commit-source
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
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
