import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/core/effect-claim";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  projectWorkspaceOperation,
  settleWorkspaceOperationCompleted,
  workspaceOperationToolResult,
  workspaceOpBoundaryPackage,
} from "../src";

const claim = makePreClaim({
  operationRef: "tool:run-1:call-1",
  scopeRef: { kind: "conversation", scopeId: "run-1" },
  effectAuthorityRef: { authorityClass: "workspace", authorityId: "tool:write_file" },
  originRef: { originId: "run:1", originKind: "submit" },
});

describe("@agent-os/workspace-op", () => {
  it("declares workspace_op.* under one carrier-owned fact owner", () => {
    expect(WORKSPACE_OP_FACT_OWNER).toBe("@agent-os/workspace-op");
    expect(workspaceOpBoundaryPackage("0.2.9")).toMatchObject({
      packageId: "@agent-os/workspace-op",
      kindPrefixes: ["workspace_op."],
    });
  });

  it("projects requested and external-receipt completed workspace operation state", () => {
    const completedClaim = settleWorkspaceOperationCompleted(claim, {
      requestedEventId: 10,
      idempotencyKey: claim.operationRef,
    });
    const events = [
      {
        id: 10,
        kind: WORKSPACE_OP_KIND.REQUESTED,
        payload: {
          requestedBy: "@agent-os/workspace-binding",
          workspaceRef: "workspace:test",
          toolName: "write_file",
          path: "out.txt",
          content: "redacted from completed payload",
          envRefs: [{ name: "API_TOKEN", ref: "env:api-token" }],
          materialRefs: ["credential:workspace-token"],
          claim,
        },
      },
      {
        id: 11,
        kind: WORKSPACE_OP_KIND.COMPLETED,
        payload: {
          requestedEventId: 10,
          operationRef: claim.operationRef,
          workspaceRef: "workspace:test",
          toolName: "write_file",
          idempotencyKey: claim.operationRef,
          resultHash: "sha256:abc",
          path: "out.txt",
          bytesWritten: 4,
          claim: completedClaim,
        },
      },
    ];

    const projection = projectWorkspaceOperation(events, 10);
    expect(projection).toMatchObject({
      status: "completed",
      requestedEventId: 10,
      result: {
        kind: "write_file",
        path: "out.txt",
        bytesWritten: 4,
        resultHash: "sha256:abc",
      },
    });
    if (projection.status !== "completed") expect.fail("expected completed projection");
    expect(projection.completed.claim.anchorRef.anchorKind).toBe("external_receipt");
    expect(workspaceOperationToolResult(projection.completed)).toEqual(projection.result);
    expect(projection.request.envRefs).toEqual([{ name: "API_TOKEN", ref: "env:api-token" }]);
    expect(projection.request.materialRefs).toEqual(["credential:workspace-token"]);
    expect("content" in projection.completed).toBe(false);
  });

  it("accepts bash receipts and rejects obsolete operation names by contract", () => {
    const bashClaim = makePreClaim({
      ...claim,
      operationRef: "tool:run-1:bash-1",
      effectAuthorityRef: { authorityClass: "workspace", authorityId: "tool:bash" },
    });
    const completedClaim = settleWorkspaceOperationCompleted(bashClaim, {
      requestedEventId: 20,
      idempotencyKey: bashClaim.operationRef,
    });
    const events = [
      {
        id: 20,
        kind: WORKSPACE_OP_KIND.REQUESTED,
        payload: {
          requestedBy: "@agent-os/workspace-binding",
          workspaceRef: "workspace:test",
          toolName: "bash",
          command: "rm old.txt",
          claim: bashClaim,
        },
      },
      {
        id: 21,
        kind: WORKSPACE_OP_KIND.COMPLETED,
        payload: {
          requestedEventId: 20,
          operationRef: bashClaim.operationRef,
          workspaceRef: "workspace:test",
          toolName: "bash",
          idempotencyKey: bashClaim.operationRef,
          resultHash: "sha256:bash",
          command: "rm old.txt",
          cwd: ".",
          exitCode: 0,
          stdoutPreview: "",
          stderrPreview: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutHash: "sha256:stdout",
          stderrHash: "sha256:stderr",
          durationMs: 3,
          claim: completedClaim,
        },
      },
      {
        id: 30,
        kind: WORKSPACE_OP_KIND.REQUESTED,
        payload: {
          requestedBy: "@agent-os/workspace-binding",
          workspaceRef: "workspace:test",
          toolName: "run_shell",
          command: "rm old.txt",
          claim,
        },
      },
    ];

    expect(projectWorkspaceOperation(events, 20)).toMatchObject({
      status: "completed",
      result: {
        kind: "bash",
        command: "rm old.txt",
        exitCode: 0,
        resultHash: "sha256:bash",
      },
    });
    expect(projectWorkspaceOperation(events, 30)).toEqual({
      status: "missing",
      requestedEventId: 30,
    });
  });
});
