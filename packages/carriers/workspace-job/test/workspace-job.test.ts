import { describe, expect, it } from "@effect/vitest";
import {
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  projectWorkspaceJob,
  projectWorkspaceJobAttempt,
  projectWorkspaceJobByIdempotencyKey,
  rejectWorkspaceJobByVerifier,
  rejectWorkspaceJobFailed,
  settleWorkspaceJobArtifactReadbackVerified,
  settleWorkspaceJobReconcileRequired,
  settleWorkspaceJobTerminalFinalized,
  settleWorkspaceJobVerified,
  workspaceJobArtifactReadbackVerifiedPayload,
  workspaceJobBoundaryPackage,
  workspaceJobCarrier,
  workspaceJobFailedPayload,
  workspaceJobFailureCode,
  workspaceJobPreClaim,
  workspaceJobReconcileRequiredPayload,
  workspaceJobRequestedPayload,
  workspaceJobTerminalFinalizedPayload,
  workspaceJobVerifierRejectedPayload,
  workspaceJobVerifiedPayload,
} from "../src";

const claim = workspaceJobPreClaim({
  runId: "run-1",
  idempotencyKey: "run:1",
  scopeRef: { kind: "conversation", scopeId: "run-1" },
  effectAuthorityRef: { authorityClass: "workspace_job", authorityId: "@agent-os/runtime" },
});

const artifact = {
  artifactRef: "workspace-job://run-1/output/result.json",
  path: "/output/result.json",
  schemaId: "zeroy.agent_command_result.v1",
  sha256: "sha256:delivery-bytes",
  bytes: 42,
};

const requested = workspaceJobRequestedPayload({
  runId: "run-1",
  idempotencyKey: "request-1",
  requestedBy: "zeroy",
  terminalSchemaId: artifact.schemaId,
  workspaceRef: "workspace:run-1",
  claim,
});

describe("@agent-os/workspace-job", () => {
  it("declares workspace_job.* under one carrier-owned fact owner", () => {
    expect(WORKSPACE_JOB_FACT_OWNER).toBe("@agent-os/workspace-job");
    expect(workspaceJobBoundaryPackage("0.2.9")).toMatchObject({
      packageId: "@agent-os/workspace-job",
      kindPrefixes: ["workspace_job."],
    });
  });

  it("owns workspace-job claim refs and failure code generation", () => {
    expect(claim).toMatchObject({
      operationRef: "workspace_job:run-1",
      originRef: { originId: "run:1", originKind: "workspace_job" },
    });
    expect(workspaceJobFailureCode("submit", "interrupted")).toBe(
      "workspace_job.submit.interrupted",
    );
  });

  it("projects requested rows as running and maps idempotency key to the first run", () => {
    const events = [
      {
        id: 10,
        kind: WORKSPACE_JOB_KIND.REQUESTED,
        factOwnerRef: WORKSPACE_JOB_FACT_OWNER,
        payload: requested,
      },
    ];

    expect(projectWorkspaceJob(events, "run-1")).toMatchObject({
      status: "running",
      runId: "run-1",
      requestedEventId: 10,
      request: { idempotencyKey: "request-1" },
    });
    expect(projectWorkspaceJobByIdempotencyKey(events, "request-1")).toMatchObject({
      status: "found",
      runId: "run-1",
      requestedEventId: 10,
    });
  });

  it("projects the latest attempt as job truth while preserving per-attempt projection", () => {
    const rejectedClaim = rejectWorkspaceJobByVerifier(claim, {
      runId: "run-1",
      requestedEventId: 10,
      terminalFinalizedEventId: 12,
    });
    const verifiedClaim = settleWorkspaceJobVerified(claim, {
      runId: "run-1",
      requestedEventId: 20,
      terminalFinalizedEventId: 22,
    });
    const retryArtifact = {
      ...artifact,
      artifactRef: "workspace-job://run-1/output/result-retry.json",
      sha256: "sha256:retry-delivery-bytes",
    };
    const events = [
      {
        id: 10,
        kind: WORKSPACE_JOB_KIND.REQUESTED,
        payload: workspaceJobRequestedPayload({
          ...requested,
          idempotencyKey: "request-1",
          attempt: { index: 1, maxAttempts: 2, cause: "initial" },
          claim,
        }),
      },
      {
        id: 11,
        kind: WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        payload: workspaceJobArtifactReadbackVerifiedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          path: artifact.path,
          artifactRef: artifact.artifactRef,
          submitRunId: 7,
          schemaId: artifact.schemaId,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          claim: settleWorkspaceJobArtifactReadbackVerified(claim, {
            runId: "run-1",
            requestedEventId: 10,
            artifactRef: artifact.artifactRef,
            sha256: artifact.sha256,
          }),
        }),
      },
      {
        id: 12,
        kind: WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
        payload: workspaceJobTerminalFinalizedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          terminalArtifact: artifact,
          claim: settleWorkspaceJobTerminalFinalized(claim, {
            runId: "run-1",
            requestedEventId: 10,
            artifactRef: artifact.artifactRef,
          }),
        }),
      },
      {
        id: 13,
        kind: WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
        payload: workspaceJobVerifierRejectedPayload({
          requestedEventId: 10,
          terminalFinalizedEventId: 12,
          runId: "run-1",
          idempotencyKey: "request-1",
          checks: [{ name: "php-lint", status: "failed" }],
          summary: "php lint failed",
          claim: rejectedClaim,
        }),
      },
      {
        id: 20,
        kind: WORKSPACE_JOB_KIND.REQUESTED,
        payload: workspaceJobRequestedPayload({
          ...requested,
          idempotencyKey: "request-1:repair:2",
          attempt: {
            index: 2,
            maxAttempts: 2,
            cause: "verifier_repair",
            repairOfRequestedEventId: 10,
          },
          claim,
        }),
      },
      {
        id: 21,
        kind: WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        payload: workspaceJobArtifactReadbackVerifiedPayload({
          requestedEventId: 20,
          runId: "run-1",
          idempotencyKey: "request-1:repair:2",
          path: retryArtifact.path,
          artifactRef: retryArtifact.artifactRef,
          submitRunId: 8,
          schemaId: retryArtifact.schemaId,
          bytes: retryArtifact.bytes,
          sha256: retryArtifact.sha256,
          claim: settleWorkspaceJobArtifactReadbackVerified(claim, {
            runId: "run-1",
            requestedEventId: 20,
            artifactRef: retryArtifact.artifactRef,
            sha256: retryArtifact.sha256,
          }),
        }),
      },
      {
        id: 22,
        kind: WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
        payload: workspaceJobTerminalFinalizedPayload({
          requestedEventId: 20,
          runId: "run-1",
          idempotencyKey: "request-1:repair:2",
          terminalArtifact: retryArtifact,
          claim: settleWorkspaceJobTerminalFinalized(claim, {
            runId: "run-1",
            requestedEventId: 20,
            artifactRef: retryArtifact.artifactRef,
          }),
        }),
      },
      {
        id: 23,
        kind: WORKSPACE_JOB_KIND.VERIFIED,
        payload: workspaceJobVerifiedPayload({
          requestedEventId: 20,
          terminalFinalizedEventId: 22,
          runId: "run-1",
          idempotencyKey: "request-1:repair:2",
          checks: [{ name: "php-lint", status: "passed" }],
          claim: verifiedClaim,
        }),
      },
    ];

    expect(projectWorkspaceJobAttempt(events, "run-1", 10)).toMatchObject({
      status: "verifier_rejected",
      checks: [{ name: "php-lint", status: "failed" }],
    });
    expect(projectWorkspaceJob(events, "run-1")).toMatchObject({
      status: "verified",
      requestedEventId: 20,
      request: {
        attempt: { index: 2, cause: "verifier_repair", repairOfRequestedEventId: 10 },
      },
      terminalArtifact: retryArtifact,
    });
    expect(projectWorkspaceJobByIdempotencyKey(events, "request-1:repair:2")).toMatchObject({
      status: "found",
      requestedEventId: 20,
      runId: "run-1",
    });
  });

  it("keeps verified, verifier_rejected, and failed terminal states distinct", () => {
    const finalizedClaim = settleWorkspaceJobTerminalFinalized(claim, {
      runId: "run-1",
      requestedEventId: 10,
      artifactRef: artifact.artifactRef,
    });
    const readbackClaim = settleWorkspaceJobArtifactReadbackVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      artifactRef: artifact.artifactRef,
      sha256: artifact.sha256,
    });
    const verifiedClaim = settleWorkspaceJobVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      terminalFinalizedEventId: 12,
    });
    const run2Artifact = {
      ...artifact,
      artifactRef: "workspace-job://run-2/output/result.json",
    };
    const run2FinalizedClaim = settleWorkspaceJobTerminalFinalized(claim, {
      runId: "run-2",
      requestedEventId: 20,
      artifactRef: run2Artifact.artifactRef,
    });
    const run2ReadbackClaim = settleWorkspaceJobArtifactReadbackVerified(claim, {
      runId: "run-2",
      requestedEventId: 20,
      artifactRef: run2Artifact.artifactRef,
      sha256: run2Artifact.sha256,
    });
    const verifierRejectedClaim = rejectWorkspaceJobByVerifier(claim, {
      runId: "run-2",
      requestedEventId: 20,
      terminalFinalizedEventId: 22,
    });
    const failedClaim = rejectWorkspaceJobFailed(claim, {
      runId: "run-3",
      requestedEventId: 30,
    });

    const run2Requested = workspaceJobRequestedPayload({
      ...requested,
      runId: "run-2",
      idempotencyKey: "request-2",
      claim,
    });
    const run3Requested = workspaceJobRequestedPayload({
      ...requested,
      runId: "run-3",
      idempotencyKey: "request-3",
      claim,
    });

    const events = [
      { id: 10, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: requested },
      {
        id: 11,
        kind: WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        payload: workspaceJobArtifactReadbackVerifiedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          path: artifact.path,
          artifactRef: artifact.artifactRef,
          submitRunId: 7,
          schemaId: artifact.schemaId,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          claim: readbackClaim,
        }),
      },
      {
        id: 12,
        kind: WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
        payload: workspaceJobTerminalFinalizedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          terminalArtifact: artifact,
          claim: finalizedClaim,
        }),
      },
      {
        id: 13,
        kind: WORKSPACE_JOB_KIND.VERIFIED,
        payload: workspaceJobVerifiedPayload({
          requestedEventId: 10,
          terminalFinalizedEventId: 12,
          runId: "run-1",
          idempotencyKey: "request-1",
          checks: [{ name: "php-lint", status: "passed" }],
          claim: verifiedClaim,
        }),
      },
      { id: 20, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: run2Requested },
      {
        id: 21,
        kind: WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        payload: workspaceJobArtifactReadbackVerifiedPayload({
          requestedEventId: 20,
          runId: "run-2",
          idempotencyKey: "request-2",
          path: run2Artifact.path,
          artifactRef: run2Artifact.artifactRef,
          submitRunId: 7,
          schemaId: run2Artifact.schemaId,
          bytes: run2Artifact.bytes,
          sha256: run2Artifact.sha256,
          claim: run2ReadbackClaim,
        }),
      },
      {
        id: 22,
        kind: WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
        payload: workspaceJobTerminalFinalizedPayload({
          requestedEventId: 20,
          runId: "run-2",
          idempotencyKey: "request-2",
          terminalArtifact: run2Artifact,
          claim: run2FinalizedClaim,
        }),
      },
      {
        id: 23,
        kind: WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
        payload: workspaceJobVerifierRejectedPayload({
          requestedEventId: 20,
          terminalFinalizedEventId: 22,
          runId: "run-2",
          idempotencyKey: "request-2",
          checks: [{ name: "php-lint", status: "failed", message: "syntax error" }],
          claim: verifierRejectedClaim,
        }),
      },
      { id: 30, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: run3Requested },
      {
        id: 31,
        kind: WORKSPACE_JOB_KIND.FAILED,
        payload: workspaceJobFailedPayload({
          requestedEventId: 30,
          runId: "run-3",
          idempotencyKey: "request-3",
          failure: {
            phase: "submit",
            code: workspaceJobFailureCode("submit_failed"),
            reason: "submit_failed",
          },
          submitRunId: 7,
          claim: failedClaim,
        }),
      },
    ];

    expect(projectWorkspaceJob(events, "run-1")).toMatchObject({
      status: "verified",
      terminalArtifact: artifact,
      checks: [{ name: "php-lint", status: "passed" }],
    });
    expect(projectWorkspaceJob(events, "run-2")).toMatchObject({
      status: "verifier_rejected",
      checks: [{ name: "php-lint", status: "failed" }],
    });
    expect(projectWorkspaceJob(events, "run-3")).toMatchObject({
      status: "failed",
      failed: {
        submitRunId: 7,
        failure: {
          phase: "submit",
          code: workspaceJobFailureCode("submit_failed"),
          reason: "submit_failed",
        },
      },
    });
    const failedEvent = events.find((event) => event.kind === WORKSPACE_JOB_KIND.FAILED);
    expect(failedEvent).toBeDefined();
    const failedPayload = JSON.stringify(failedEvent?.payload);
    expect(failedPayload).not.toContain("diagnostics");
    expect(failedPayload).not.toContain("category");
    expect(failedPayload).not.toContain("owner");
    expect(failedPayload).not.toContain("publicMessage");
    expect(failedPayload).not.toContain('"class"');
    expect(failedPayload).not.toContain('"message"');
  });

  it("projects retryable workspace job failures as reconcile-required indeterminate facts", () => {
    const reconcileClaim = settleWorkspaceJobReconcileRequired(claim, {
      runId: "run-1",
      requestedEventId: 10,
    });
    const failure = {
      phase: "data_plane" as const,
      code: workspaceJobFailureCode("terminal_read_failed"),
      reason: "terminal_read_failed",
      retryable: true,
    };
    const retryableFailedPayload = {
      requestedEventId: 10,
      runId: "run-1",
      idempotencyKey: "request-1",
      failure,
      submitRunId: 7,
      claim: rejectWorkspaceJobFailed(claim, {
        runId: "run-1",
        requestedEventId: 10,
      }),
    };
    expect(() =>
      workspaceJobCarrier.decode(WORKSPACE_JOB_KIND.FAILED, retryableFailedPayload),
    ).toThrow(/payload violates schema/);

    const events = [
      { id: 10, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: requested },
      {
        id: 11,
        kind: WORKSPACE_JOB_KIND.RECONCILE_REQUIRED,
        payload: workspaceJobReconcileRequiredPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          failure,
          submitRunId: 7,
          claim: reconcileClaim,
        }),
      },
    ];

    expect(projectWorkspaceJob(events, "run-1")).toMatchObject({
      status: "reconcile_required",
      requestedEventId: 10,
      reconcile: {
        submitRunId: 7,
        failure,
        claim: {
          phase: "indeterminate",
          indeterminateRef: { indeterminateKind: "reconcile_required" },
        },
      },
    });
  });

  it("does not project a verdict unless it references the finalized terminal artifact fact", () => {
    const verifiedClaim = settleWorkspaceJobVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      terminalFinalizedEventId: 999,
    });
    const events = [
      { id: 10, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: requested },
      {
        id: 11,
        kind: WORKSPACE_JOB_KIND.VERIFIED,
        payload: workspaceJobVerifiedPayload({
          requestedEventId: 10,
          terminalFinalizedEventId: 999,
          runId: "run-1",
          idempotencyKey: "request-1",
          checks: [{ name: "php-lint", status: "passed" }],
          claim: verifiedClaim,
        }),
      },
    ];

    expect(projectWorkspaceJob(events, "run-1")).toMatchObject({
      status: "running",
      runId: "run-1",
    });
  });

  it("does not project a verified terminal when finalized artifact differs from readback proof", () => {
    const readbackClaim = settleWorkspaceJobArtifactReadbackVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      artifactRef: artifact.artifactRef,
      sha256: artifact.sha256,
    });
    const finalizedClaim = settleWorkspaceJobTerminalFinalized(claim, {
      runId: "run-1",
      requestedEventId: 10,
      artifactRef: artifact.artifactRef,
    });
    const verifiedClaim = settleWorkspaceJobVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      terminalFinalizedEventId: 12,
    });
    const events = [
      { id: 10, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: requested },
      {
        id: 11,
        kind: WORKSPACE_JOB_KIND.ARTIFACT_READBACK_VERIFIED,
        payload: workspaceJobArtifactReadbackVerifiedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          path: artifact.path,
          artifactRef: artifact.artifactRef,
          submitRunId: 7,
          schemaId: artifact.schemaId,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          claim: readbackClaim,
        }),
      },
      {
        id: 12,
        kind: WORKSPACE_JOB_KIND.TERMINAL_FINALIZED,
        payload: workspaceJobTerminalFinalizedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          terminalArtifact: { ...artifact, sha256: "sha256:different" },
          claim: finalizedClaim,
        }),
      },
      {
        id: 13,
        kind: WORKSPACE_JOB_KIND.VERIFIED,
        payload: workspaceJobVerifiedPayload({
          requestedEventId: 10,
          terminalFinalizedEventId: 12,
          runId: "run-1",
          idempotencyKey: "request-1",
          checks: [{ name: "php-lint", status: "passed" }],
          claim: verifiedClaim,
        }),
      },
    ];

    expect(projectWorkspaceJob(events, "run-1")).toMatchObject({
      status: "running",
      runId: "run-1",
    });
  });
});
