# @agent-os/workspace-job Public API Intent

## Public exports

- `.:WORKSPACE_JOB_EVENTS`
- `.:WORKSPACE_JOB_EVENT_PREFIX`
- `.:WORKSPACE_JOB_FACT_OWNER`
- `.:WORKSPACE_JOB_KIND`
- `.:WORKSPACE_JOB_ORIGIN_KIND`
- `.:WORKSPACE_JOB_PROJECTION_KIND`
- `.:WORKSPACE_JOB_REF_NAMESPACE`
- `.:WorkspaceJobAttempt`
- `.:WorkspaceJobFailure`
- `.:WorkspaceJobFailedPayload`
- `.:WorkspaceJobArtifactReadbackVerifiedPayload`
- `.:WorkspaceJobArtifactWrittenPayload`
- `.:WorkspaceJobIdempotencyProjection`
- `.:WorkspaceJobLedgerEvent`
- `.:WorkspaceJobProjection`
- `.:WorkspaceJobReconcileRequiredPayload`
- `.:WorkspaceJobRequestedPayload`
- `.:WorkspaceJobSeedWrittenPayload`
- `.:WorkspaceJobStepProjection`
- `.:WorkspaceJobTerminalBuildAttemptedPayload`
- `.:WorkspaceJobTerminalArtifact`
- `.:WorkspaceJobTerminalFinalizedPayload`
- `.:WorkspaceJobTerminalFailure`
- `.:WorkspaceJobVerificationCheck`
- `.:WorkspaceJobVerifiedPayload`
- `.:WorkspaceJobVerifierRejectedPayload`
- `.:projectWorkspaceJob`
- `.:projectWorkspaceJobAttempt`
- `.:projectWorkspaceJobByIdempotencyKey`
- `.:projectWorkspaceJobSafeLedgerEvent`
- `.:projectWorkspaceJobSteps`
- `.:rejectWorkspaceJobByVerifier`
- `.:rejectWorkspaceJobFailed`
- `.:settleWorkspaceJobReconcileRequired`
- `.:settleWorkspaceJobArtifactReadbackVerified`
- `.:settleWorkspaceJobArtifactWritten`
- `.:settleWorkspaceJobSeedWritten`
- `.:settleWorkspaceJobTerminalBuildAttempted`
- `.:settleWorkspaceJobTerminalFinalized`
- `.:settleWorkspaceJobVerified`
- `.:workspaceJobBoundaryContract`
- `.:workspaceJobBoundaryPackage`
- `.:workspaceJobCarrier`
- `.:workspaceJobFailedPayload`
- `.:workspaceJobFailureCode`
- `.:workspaceJobOperationRef`
- `.:workspaceJobOriginRef`
- `.:workspaceJobPreClaim`
- `.:workspaceJobReconcileRequiredPayload`
- `.:workspaceJobRequestedPayload`
- `.:workspaceJobSettlementContract`
- `.:workspaceJobSettlementRef`
- `.:workspaceJobArtifactReadbackVerifiedPayload`
- `.:workspaceJobArtifactWrittenPayload`
- `.:workspaceJobSeedWrittenPayload`
- `.:workspaceJobTerminalBuildAttemptedPayload`
- `.:workspaceJobTerminalFinalizedPayload`
- `.:workspaceJobVerifiedPayload`
- `.:workspaceJobVerifierRejectedPayload`

## Experimental exports

None.

## Internal-only exports

Any package file or symbol not listed above.
