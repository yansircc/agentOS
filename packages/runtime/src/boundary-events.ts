import { Context, Effect } from "effect";
import type { BoundaryContract } from "@agent-os/core/boundary-contract";
import type { JsonStringifyError } from "@agent-os/core/errors";
import type { RecordedLedgerEvent } from "@agent-os/core/types";
import type { RuntimeEventCommitSpec } from "@agent-os/core/runtime-protocol";
import type { BoundaryCommitRejected } from "./boundary-commit";
import type { RuntimeStorageError } from "./ledger";

/**
 * Runtime access to package-owned boundary event commits.
 *
 * The runtime ledger service owns only `@agent-os/runtime` facts. Carrier
 * events such as `decision_gate.*` must be admitted through their boundary
 * contract so factOwnerRef remains the carrier package id.
 *
 * @public
 */
export class BoundaryEvents extends Context.Service<
  BoundaryEvents,
  {
    readonly commit: (
      contract: BoundaryContract,
      event: string,
      payload: unknown,
    ) => Effect.Effect<
      RecordedLedgerEvent,
      BoundaryCommitRejected | RuntimeStorageError | JsonStringifyError
    >;
    readonly commitWithRuntimeEvents: (
      contract: BoundaryContract,
      event: string,
      payload: unknown,
      runtimeEvents: (
        boundaryEventId: number,
      ) => readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
    ) => Effect.Effect<
      readonly [RecordedLedgerEvent, ...RecordedLedgerEvent[]],
      BoundaryCommitRejected | RuntimeStorageError | JsonStringifyError
    >;
  }
>()("@agent-os/BoundaryEvents") {}
