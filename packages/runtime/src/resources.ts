import { Context, Effect } from "effect";
import type {
  InvalidResourceAmount,
  JsonStringifyError,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
} from "@agent-os/core/errors";
import type {
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/core/types";
import type { ResourceProjection } from "@agent-os/core/backend-protocol";
import type { LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";
import type { RuntimeStorageError } from "./ledger";

export class Resources extends Context.Service<
  Resources,
  {
    readonly grant: (
      identity: LedgerTruthIdentity,
      spec: ResourceGrantSpec,
    ) => Effect.Effect<
      ResourceGrantResult,
      RuntimeStorageError | JsonStringifyError | InvalidResourceAmount
    >;
    readonly reserve: (
      identity: LedgerTruthIdentity,
      spec: ResourceReserveSpec,
    ) => Effect.Effect<
      ResourceReserveResult,
      RuntimeStorageError | JsonStringifyError | InvalidResourceAmount | ResourceInsufficient
    >;
    readonly consume: (
      identity: LedgerTruthIdentity,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      | RuntimeStorageError
      | JsonStringifyError
      | ResourceReservationNotFound
      | ResourceReservationClosed
    >;
    readonly release: (
      identity: LedgerTruthIdentity,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      | RuntimeStorageError
      | JsonStringifyError
      | ResourceReservationNotFound
      | ResourceReservationClosed
    >;
    readonly project: (
      identity: LedgerTruthIdentity,
      key: string,
    ) => Effect.Effect<ResourceProjection, RuntimeStorageError>;
  }
>()("@agent-os/Resources") {}
