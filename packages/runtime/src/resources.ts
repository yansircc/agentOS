import { Context, Effect } from "effect";
import type {
  InvalidResourceAmount,
  JsonStringifyError,
  ResourceInsufficient,
  ResourceReservationClosed,
  ResourceReservationNotFound,
  SqlError,
} from "@agent-os/kernel/errors";
import type {
  ResourceGrantResult,
  ResourceGrantSpec,
  ResourceReservationSpec,
  ResourceReserveResult,
  ResourceReserveSpec,
} from "@agent-os/kernel/types";
import type { ResourceProjection } from "@agent-os/backend-protocol";
import type { LedgerTruthIdentity } from "@agent-os/runtime-protocol";

export class Resources extends Context.Service<
  Resources,
  {
    readonly grant: (
      identity: LedgerTruthIdentity,
      spec: ResourceGrantSpec,
    ) => Effect.Effect<ResourceGrantResult, SqlError | JsonStringifyError | InvalidResourceAmount>;
    readonly reserve: (
      identity: LedgerTruthIdentity,
      spec: ResourceReserveSpec,
    ) => Effect.Effect<
      ResourceReserveResult,
      SqlError | JsonStringifyError | InvalidResourceAmount | ResourceInsufficient
    >;
    readonly consume: (
      identity: LedgerTruthIdentity,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      SqlError | JsonStringifyError | ResourceReservationNotFound | ResourceReservationClosed
    >;
    readonly release: (
      identity: LedgerTruthIdentity,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      SqlError | JsonStringifyError | ResourceReservationNotFound | ResourceReservationClosed
    >;
    readonly project: (
      identity: LedgerTruthIdentity,
      key: string,
    ) => Effect.Effect<ResourceProjection, SqlError>;
  }
>()("@agent-os/Resources") {}
