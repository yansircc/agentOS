import { Context, Effect } from "effect";
import type { BoundaryContract } from "@agent-os/kernel/boundary-contract";
import type { JsonStringifyError, SqlError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { BoundaryCommitRejected } from "./boundary-commit";

/**
 * Runtime access to package-owned boundary event commits.
 *
 * The runtime ledger service owns only `@agent-os/runtime` facts. Carrier
 * events such as `decision_gate.*` must be admitted through their boundary
 * contract so factOwnerRef remains the carrier package id.
 *
 * @public
 */
export class BoundaryEvents extends Context.Tag("@agent-os/BoundaryEvents")<
  BoundaryEvents,
  {
    readonly commit: (
      contract: BoundaryContract,
      event: string,
      payload: unknown,
    ) => Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError>;
  }
>() {}
