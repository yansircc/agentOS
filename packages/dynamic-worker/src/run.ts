import { Clock, Duration, Effect } from "effect";
import { settleLivedClaim, settleRejectedClaim } from "@agent-os/core/effect-claim";
import { resolveRuntimeScope } from "@agent-os/core/runtime-scope";

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
): Effect.Effect<DynamicWorkerRunSuccess, DynamicWorkerFailure | DynamicWorkerPolicyDenied> =>
  Effect.gen(function* () {
    const rejectPolicy = (denied: DynamicWorkerPolicyDenied): DynamicWorkerPolicyDenied =>
      request.claim === undefined
        ? denied
        : new DynamicWorkerPolicyDenied({
            reason: denied.reason,
            claim: settleRejectedClaim(request.claim, {
              rejectionId: request.claim.operationRef,
              rejectionKind: "policy_denied",
              reason: denied.reason,
            }),
          });
    const rejectFailure = (failure: DynamicWorkerFailure): DynamicWorkerFailure =>
      request.claim === undefined || failure.claim !== undefined
        ? failure
        : new DynamicWorkerFailure({
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
    const scopeRef = request.claim?.scopeRef ?? request.scopeRef;
    const runtimeScope = scopeRef === undefined ? undefined : resolveRuntimeScope(scopeRef);
    yield* policy({
      request,
      ...(runtimeScope === undefined ? {} : { runtimeScope }),
    }).pipe(Effect.mapError(rejectPolicy));
    const started = yield* Clock.currentTimeMillis;
    const result = yield* backend.run(request).pipe(
      Effect.mapError(rejectFailure),
      Effect.timeoutFail({
        duration: Duration.millis(request.timeoutMs),
        onTimeout: () =>
          rejectFailure(
            new DynamicWorkerFailure({
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
      ...(request.claim === undefined
        ? {}
        : {
            claim: settleLivedClaim(request.claim, {
              anchorId: result.workerId,
              anchorKind: "carrier_proof",
              carrierRef: "dynamic-worker",
            }),
          }),
    };
  });
