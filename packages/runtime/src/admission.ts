import { Context, Effect } from "effect";
import type { JsonStringifyError, UpstreamFailure } from "@agent-os/core/errors";
import type { AttemptResult, AttemptSpec, InvalidateSpec } from "@agent-os/core/runtime-protocol";
import type { RuntimeStorageError } from "./ledger";

export interface Admission {
  readonly attemptStructured: <O>(
    spec: AttemptSpec,
  ) => Effect.Effect<AttemptResult<O>, RuntimeStorageError | JsonStringifyError | UpstreamFailure>;
  readonly invalidate: (
    spec: InvalidateSpec,
  ) => Effect.Effect<{ readonly barrierId: number }, RuntimeStorageError | JsonStringifyError>;
}

export const Admission: Context.Service<Admission, Admission> = Context.Service<
  Admission,
  Admission
>("@agent-os/Admission");
