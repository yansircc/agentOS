import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/kernel/types";
import type { LedgerCommitEventSpec, LedgerTruthIdentity } from "@agent-os/runtime-protocol";

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
      opts?: Pick<EventQueryOptions, "afterId" | "kinds" | "factOwnerRefs">,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
  }
>() {}
