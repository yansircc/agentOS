import { Clock, Duration, Effect } from "effect";

import { validateDynamicWorkerRequest } from "./policy";
import {
  DynamicWorkerFailure,
  type DynamicWorkerBackend,
  type DynamicWorkerPolicy,
  DynamicWorkerPolicyDenied,
  type DynamicWorkerRunRequest,
  type DynamicWorkerRunSuccess,
} from "./types";

export const runDynamicWorker = (
  backend: DynamicWorkerBackend,
  policy: DynamicWorkerPolicy,
  request: DynamicWorkerRunRequest,
): Effect.Effect<
  DynamicWorkerRunSuccess,
  DynamicWorkerFailure | DynamicWorkerPolicyDenied
> =>
  Effect.gen(function* () {
    yield* validateDynamicWorkerRequest(request);
    yield* policy({ request });
    const started = yield* Clock.currentTimeMillis;
    const result = yield* backend.run(request).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(request.timeoutMs),
        onTimeout: () =>
          new DynamicWorkerFailure({
            code: "Timeout",
            reason: `dynamic worker run exceeded ${request.timeoutMs}ms`,
          }),
      }),
    );
    const ended = yield* Clock.currentTimeMillis;
    return { ...result, durationMs: ended - started };
  });
