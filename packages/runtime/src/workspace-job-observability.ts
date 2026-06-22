import type { LedgerEvent } from "@agent-os/core/types";
import {
  projectWorkspaceJob,
  type WorkspaceJobFailure,
  type WorkspaceJobAttempt,
  type WorkspaceJobRequestedPayload,
  type WorkspaceJobTerminalArtifact,
  type WorkspaceJobVerificationCheck,
} from "./workspace-job-carrier";
import {
  failureDiagnosticEnvelopeForReason,
  projectFailureDiagnostics,
  type FailureDiagnostic,
  type FailureDiagnosticEnvelope,
} from "@agent-os/core/runtime-protocol";

export interface WorkspaceJobObservabilityRequest {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly requestedBy: string;
  readonly terminalSchemaId: string;
  readonly workspaceRef?: string;
  readonly inputRef?: string;
  readonly inputHash?: string;
  readonly attempt?: WorkspaceJobAttempt;
}

export interface WorkspaceJobFailureExplanation extends FailureDiagnosticEnvelope {
  readonly phase: WorkspaceJobFailure["phase"];
  readonly code: string;
  readonly reason: string;
  readonly terminalReason?: string;
  readonly diagnostics: ReadonlyArray<FailureDiagnostic>;
}

export type WorkspaceJobObservabilityProjection =
  | {
      readonly status: "missing";
      readonly runId: string;
    }
  | {
      readonly status: "running";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobObservabilityRequest;
    }
  | {
      readonly status: "verified";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobObservabilityRequest;
      readonly terminalArtifact: WorkspaceJobTerminalArtifact;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
    }
  | {
      readonly status: "verifier_rejected";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobObservabilityRequest;
      readonly terminalArtifact: WorkspaceJobTerminalArtifact;
      readonly checks: ReadonlyArray<WorkspaceJobVerificationCheck>;
      readonly summary?: string;
    }
  | {
      readonly status: "failed";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobObservabilityRequest;
      readonly failureExplanation: WorkspaceJobFailureExplanation;
    }
  | {
      readonly status: "reconcile_required";
      readonly runId: string;
      readonly requestedEventId: number;
      readonly request: WorkspaceJobObservabilityRequest;
      readonly failureExplanation: WorkspaceJobFailureExplanation;
    };

const requestSummary = (
  request: WorkspaceJobRequestedPayload,
): WorkspaceJobObservabilityRequest => ({
  runId: request.runId,
  idempotencyKey: request.idempotencyKey,
  requestedBy: request.requestedBy,
  terminalSchemaId: request.terminalSchemaId,
  ...(request.workspaceRef === undefined ? {} : { workspaceRef: request.workspaceRef }),
  ...(request.inputRef === undefined ? {} : { inputRef: request.inputRef }),
  ...(request.inputHash === undefined ? {} : { inputHash: request.inputHash }),
  ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
});

const explanationEnvelope = (
  failure: WorkspaceJobFailure,
  diagnostics: ReadonlyArray<FailureDiagnostic>,
  terminalReason?: string,
): FailureDiagnosticEnvelope => {
  const primary = diagnostics[0];
  if (primary !== undefined) {
    return {
      category: primary.category,
      owner: primary.owner,
      retryable: primary.retryable,
      publicMessage: primary.publicMessage,
    };
  }
  return failureDiagnosticEnvelopeForReason(
    stableEnvelopeReasonForWorkspaceJobFailure(failure) ?? terminalReason ?? failure.reason,
  );
};

const dataPlaneFailureCodes = new Set([
  "workspace_job.seed_write_failed",
  "workspace_job.terminal_write_failed",
  "workspace_job.terminal_read_failed",
  "workspace_job.data_plane_failed",
]);

const stableEnvelopeReasonForWorkspaceJobFailure = (
  failure: WorkspaceJobFailure,
): string | undefined => {
  if (!dataPlaneFailureCodes.has(failure.code)) return undefined;
  return failure.code.slice("workspace_job.".length);
};

const failureExplanation = (
  failure: WorkspaceJobFailure,
  diagnostics: ReadonlyArray<FailureDiagnostic>,
  terminalReason?: string,
): WorkspaceJobFailureExplanation => ({
  phase: failure.phase,
  code: failure.code,
  reason: failure.reason,
  ...explanationEnvelope(failure, diagnostics, terminalReason),
  ...(terminalReason === undefined ? {} : { terminalReason }),
  diagnostics,
});

/**
 * Projects a consumer-safe workspace job view by joining workspace-job terminal
 * facts with runtime diagnostic projections. The raw carrier projection may
 * expose substrate/debug join keys; this projection never exposes them.
 *
 * @agentosPrimitive primitive.runtime.projectWorkspaceJobObservability
 * @agentosInvariant invariant.workspace-job.failure-observability-join
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const projectWorkspaceJobObservability = (
  events: ReadonlyArray<LedgerEvent>,
  jobRunId: string,
): WorkspaceJobObservabilityProjection => {
  const projection = projectWorkspaceJob(events, jobRunId);
  switch (projection.status) {
    case "missing":
      return projection;
    case "running":
      return {
        status: "running",
        runId: projection.runId,
        requestedEventId: projection.requestedEventId,
        request: requestSummary(projection.request),
      };
    case "verified":
      return {
        status: "verified",
        runId: projection.runId,
        requestedEventId: projection.requestedEventId,
        request: requestSummary(projection.request),
        terminalArtifact: projection.terminalArtifact,
        checks: projection.checks,
      };
    case "verifier_rejected":
      return {
        status: "verifier_rejected",
        runId: projection.runId,
        requestedEventId: projection.requestedEventId,
        request: requestSummary(projection.request),
        terminalArtifact: projection.terminalArtifact,
        checks: projection.checks,
        ...(projection.rejected.summary === undefined
          ? {}
          : { summary: projection.rejected.summary }),
      };
    case "failed": {
      const diagnostics =
        projection.failed.submitRunId === undefined
          ? null
          : projectFailureDiagnostics(events, projection.failed.submitRunId);
      return {
        status: "failed",
        runId: projection.runId,
        requestedEventId: projection.requestedEventId,
        request: requestSummary(projection.request),
        failureExplanation: failureExplanation(
          projection.failed.failure,
          diagnostics?.diagnostics ?? [],
          diagnostics?.terminalReason,
        ),
      };
    }
    case "reconcile_required": {
      const diagnostics =
        projection.reconcile.submitRunId === undefined
          ? null
          : projectFailureDiagnostics(events, projection.reconcile.submitRunId);
      return {
        status: "reconcile_required",
        runId: projection.runId,
        requestedEventId: projection.requestedEventId,
        request: requestSummary(projection.request),
        failureExplanation: failureExplanation(
          projection.reconcile.failure,
          diagnostics?.diagnostics ?? [],
          diagnostics?.terminalReason,
        ),
      };
    }
  }
};
