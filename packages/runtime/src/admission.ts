import { Context, Effect } from "effect";
import type { JsonStringifyError, SqlError, UpstreamFailure } from "@agent-os/kernel/errors";
import type { AttemptResult, AttemptSpec, InvalidateSpec } from "@agent-os/runtime-protocol";

export class Admission extends Context.Tag("@agent-os/Admission")<
  Admission,
  {
    readonly attemptStructured: <O>(
      spec: AttemptSpec,
    ) => Effect.Effect<AttemptResult<O>, SqlError | JsonStringifyError | UpstreamFailure>;
    readonly invalidate: (
      spec: InvalidateSpec,
    ) => Effect.Effect<{ readonly barrierId: number }, SqlError | JsonStringifyError>;
  }
>() {}
