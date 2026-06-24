/**
 * Runtime diagnostic API for capability authors
 * @internal
 */

import {
  runtimeDiagnosticBoundaryContract,
  RUNTIME_DIAGNOSTIC_KIND,
} from "../runtime-diagnostic-carrier";

/**
 * Runtime diagnostic API available during capability install and runtime
 */
export interface RuntimeDiagnosticApi {
  readonly handlerFailed: (input: {
    readonly handler: string;
    readonly reason: string;
    readonly requestedEventId: number;
  }) => void;
  readonly projectionTimeout: (input: {
    readonly projectionKind: string;
    readonly waitReason: "missing" | "not_ready";
    readonly maxAttempts: number;
    readonly lastObservedEventId?: number;
    readonly operationRef?: string;
    readonly authority?: string;
    readonly requestedEventId: number;
  }) => void;
}

/**
 * Boundary events commit interface
 * @internal
 */
export interface DiagnosticCommitter {
  readonly commit: (
    contract: typeof runtimeDiagnosticBoundaryContract,
    event: string,
    payload: unknown,
  ) => Promise<unknown>;
}

/**
 * Create runtime diagnostic API for a given capability
 * @internal
 */
export const createRuntimeDiagnosticApi = (
  capabilityId: string,
  commit: DiagnosticCommitter["commit"],
): RuntimeDiagnosticApi => ({
  handlerFailed: ({ handler, reason, requestedEventId }) => {
    void commit(runtimeDiagnosticBoundaryContract, RUNTIME_DIAGNOSTIC_KIND.HANDLER_FAILED, {
      capabilityId,
      handler,
      reason,
      requestedEventId,
    }).catch(() => undefined);
  },
  projectionTimeout: ({
    projectionKind,
    waitReason,
    maxAttempts,
    lastObservedEventId,
    operationRef,
    authority,
    requestedEventId,
  }) => {
    void commit(runtimeDiagnosticBoundaryContract, RUNTIME_DIAGNOSTIC_KIND.PROJECTION_TIMEOUT, {
      capabilityId,
      projectionKind,
      waitReason,
      maxAttempts,
      ...(lastObservedEventId === undefined ? {} : { lastObservedEventId }),
      ...(operationRef === undefined ? {} : { operationRef }),
      ...(authority === undefined ? {} : { authority }),
      requestedEventId,
    }).catch(() => undefined);
  },
});
