import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import {
  WORKSPACE_JOB_FACT_OWNER,
  WORKSPACE_JOB_KIND,
  projectWorkspaceJob,
  projectWorkspaceJobByIdempotencyKey,
  rejectWorkspaceJobByVerifier,
  rejectWorkspaceJobFailed,
  settleWorkspaceJobVerified,
  workspaceJobBoundaryPackage,
  workspaceJobFailedPayload,
  workspaceJobRequestedPayload,
  workspaceJobVerifierRejectedPayload,
  workspaceJobVerifiedPayload,
} from "../src";

const claim = makePreClaim({
  operationRef: "workspace_job:run-1",
  scopeRef: { kind: "conversation", scopeId: "run-1" },
  effectAuthorityRef: { authorityClass: "workspace_job", authorityId: "@agent-os/runtime" },
  originRef: { originId: "run:1", originKind: "workspace_job" },
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
    const verifiedClaim = settleWorkspaceJobVerified(claim, {
      runId: "run-1",
      requestedEventId: 10,
      artifactRef: artifact.artifactRef,
    });
    const verifierRejectedClaim = rejectWorkspaceJobByVerifier(claim, {
      runId: "run-2",
      requestedEventId: 20,
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
        kind: WORKSPACE_JOB_KIND.VERIFIED,
        payload: workspaceJobVerifiedPayload({
          requestedEventId: 10,
          runId: "run-1",
          idempotencyKey: "request-1",
          terminalArtifact: artifact,
          checks: [{ name: "php-lint", status: "passed" }],
          claim: verifiedClaim,
        }),
      },
      { id: 20, kind: WORKSPACE_JOB_KIND.REQUESTED, payload: run2Requested },
      {
        id: 21,
        kind: WORKSPACE_JOB_KIND.VERIFIER_REJECTED,
        payload: workspaceJobVerifierRejectedPayload({
          requestedEventId: 20,
          runId: "run-2",
          idempotencyKey: "request-2",
          terminalArtifact: {
            ...artifact,
            artifactRef: "workspace-job://run-2/output/result.json",
          },
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
          failureKind: "submit_failed",
          reason: "runtime crashed",
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
      failed: { failureKind: "submit_failed" },
    });
  });
});
