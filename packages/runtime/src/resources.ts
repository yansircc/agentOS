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

export interface ResourceProjection {
  readonly available: number;
  readonly reserved: number;
  readonly consumed: number;
}

export class Resources extends Context.Tag("@agent-os/Resources")<
  Resources,
  {
    readonly grant: (
      scope: string,
      spec: ResourceGrantSpec,
    ) => Effect.Effect<ResourceGrantResult, SqlError | JsonStringifyError | InvalidResourceAmount>;
    readonly reserve: (
      scope: string,
      spec: ResourceReserveSpec,
    ) => Effect.Effect<
      ResourceReserveResult,
      SqlError | JsonStringifyError | InvalidResourceAmount | ResourceInsufficient
    >;
    readonly consume: (
      scope: string,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      SqlError | JsonStringifyError | ResourceReservationNotFound | ResourceReservationClosed
    >;
    readonly release: (
      scope: string,
      spec: ResourceReservationSpec,
    ) => Effect.Effect<
      void,
      SqlError | JsonStringifyError | ResourceReservationNotFound | ResourceReservationClosed
    >;
    readonly project: (scope: string, key: string) => Effect.Effect<ResourceProjection, SqlError>;
  }
>() {}
