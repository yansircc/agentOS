import { Clock, Duration, Effect } from "effect";
import { resolveRuntimeScope } from "@agent-os/kernel/runtime-scope";

import { validateDynamicWorkerRequest } from "./policy";
import {
  DynamicWorkerFailure,
  type DynamicWorkerBackend,
  type DynamicWorkerPolicy,
  DynamicWorkerPolicyDenied,
  type DynamicWorkerPolicyViolation,
  DynamicWorkerProviderFailure,
  type DynamicWorkerRunRequest,
  type DynamicWorkerRunSuccess,
} from "./types";
import {
  dynamicWorkerFailureReason,
  settleDynamicWorkerLived,
  settleDynamicWorkerPolicyDenied,
  settleDynamicWorkerProviderFailure,
} from "./settlement";

export const runDynamicWorker = (
  backend: DynamicWorkerBackend,
  policy: DynamicWorkerPolicy,
  request: DynamicWorkerRunRequest,
): Effect.Effect<DynamicWorkerRunSuccess, DynamicWorkerFailure | DynamicWorkerPolicyDenied> =>
  Effect.gen(function* () {
    const rejectPolicy = (denied: DynamicWorkerPolicyViolation): DynamicWorkerPolicyDenied =>
      new DynamicWorkerPolicyDenied({
        reason: denied.reason,
        claim: settleDynamicWorkerPolicyDenied(request.claim, denied.reason),
      });
    const rejectFailure = (failure: DynamicWorkerProviderFailure): DynamicWorkerFailure =>
      new DynamicWorkerFailure({
        code: failure.code,
        reason: dynamicWorkerFailureReason(failure),
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.workerId === undefined ? {} : { workerId: failure.workerId }),
        claim: settleDynamicWorkerProviderFailure(request.claim, failure),
      });

    yield* validateDynamicWorkerRequest(request).pipe(Effect.mapError(rejectPolicy));
    const runtimeScope = resolveRuntimeScope(request.claim.scopeRef);
    yield* policy({
      request,
      runtimeScope,
    }).pipe(Effect.mapError(rejectPolicy));
    const started = yield* Clock.currentTimeMillis;
    const result = yield* backend.run(request).pipe(
      Effect.mapError(rejectFailure),
      Effect.timeoutFail({
        duration: Duration.millis(request.timeoutMs),
        onTimeout: () =>
          rejectFailure(
            new DynamicWorkerProviderFailure({
              code: "Timeout",
              reason: `dynamic worker run exceeded ${request.timeoutMs}ms`,
            }),
          ),
      }),
    );
    const ended = yield* Clock.currentTimeMillis;
    return {
      ...result,
      durationMs: ended - started,
      claim: settleDynamicWorkerLived(request.claim, { workerId: result.workerId }),
    };
  });
