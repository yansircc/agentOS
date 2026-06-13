import { describe, expect, it } from "@effect/vitest";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
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
});
