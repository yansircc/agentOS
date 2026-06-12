import { describe, expect, it } from "@effect/vitest";
import {
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  projectWorkspaceJob,
  projectWorkspaceJobByIdempotencyKey,
  rejectWorkspaceJobByVerifier,
  rejectWorkspaceJobFailed,
  settleWorkspaceJobTerminalFinalized,
  settleWorkspaceJobVerified,
  workspaceJobBoundaryPackage,
  workspaceJobFailedPayload,
  workspaceJobFailureCode,
  workspaceJobPreClaim,
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

  it("keeps verified, verifier_rejected, and failed terminal states distinct", () => {
    const finalizedClaim = settleWorkspaceJobTerminalFinalized(claim, {
      runId: "run-1",
      requestedEventId: 10,
      artifactRef: artifact.artifactRef,
    });
    const verifiedClaim = settleWorkspaceJobVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      terminalFinalizedEventId: 11,
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
    const verifierRejectedClaim = rejectWorkspaceJobByVerifier(claim, {
      runId: "run-2",
      requestedEventId: 20,
      terminalFinalizedEventId: 21,
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
        id: 12,
        kind: WORKSPACE_JOB_KIND.VERIFIED,
        payload: workspaceJobVerifiedPayload({
          requestedEventId: 10,
          terminalFinalizedEventId: 11,
          runId: "run-1",
          idempotencyKey: "request-1",
          checks: [{ name: "php-lint", status: "passed" }],
          claim: verifiedClaim,
        }),
      },
      { id: 20, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: run2Requested },
      {
        id: 21,
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
        id: 22,
        kind: WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
        payload: workspaceJobVerifierRejectedPayload({
          requestedEventId: 20,
          terminalFinalizedEventId: 21,
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
            class: "provider",
            code: workspaceJobFailureCode("submit_failed"),
            message: "runtime crashed",
            retryable: true,
          },
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
        failure: {
          phase: "submit",
          class: "provider",
          code: workspaceJobFailureCode("submit_failed"),
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
});
