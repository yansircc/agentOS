import { Clock, Duration, Effect } from "effect";
import { settleLivedClaim, settleRejectedClaim } from "@agent-os/core/effect-claim";
import { resolveRuntimeScope } from "@agent-os/core/runtime-scope";

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

export const runDynamicWorker = (
  backend: DynamicWorkerBackend,
  policy: DynamicWorkerPolicy,
  request: DynamicWorkerRunRequest,
): Effect.Effect<DynamicWorkerRunSuccess, DynamicWorkerFailure | DynamicWorkerPolicyDenied> =>
  Effect.gen(function* () {
    const rejectPolicy = (denied: DynamicWorkerPolicyViolation): DynamicWorkerPolicyDenied =>
      new DynamicWorkerPolicyDenied({
        reason: denied.reason,
        claim: settleRejectedClaim(request.claim, {
          rejectionId: request.claim.operationRef,
          rejectionKind: "policy_denied",
          reason: denied.reason,
        }),
      });
    const rejectFailure = (failure: DynamicWorkerProviderFailure): DynamicWorkerFailure =>
      new DynamicWorkerFailure({
        code: failure.code,
        reason: failure.reason,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.body === undefined ? {} : { body: failure.body }),
        ...(failure.workerId === undefined ? {} : { workerId: failure.workerId }),
        claim: settleRejectedClaim(request.claim, {
          rejectionId: request.claim.operationRef,
          rejectionKind:
            failure.code === "ResourceLimitExceeded" ? "resource_denied" : "provider_rejected",
          reason: failure.reason,
        }),
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
      claim: settleLivedClaim(request.claim, {
        anchorId: result.workerId,
        anchorKind: "carrier_proof",
        carrierRef: "dynamic-worker",
      }),
    };
  });
