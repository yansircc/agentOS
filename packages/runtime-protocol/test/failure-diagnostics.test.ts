import { describe, expect, it } from "@effect/vitest";
import { ABORT } from "@agent-os/kernel/abort";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { RejectedClaim } from "@agent-os/kernel/effect-claim";
import {
  agentRunAbortedEvent,
  projectFailureDiagnostics,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "../src";

const scope = "failure-diagnostics-test";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const rejectedClaim = (reason: string): RejectedClaim => ({
  phase: "rejected",
  operationRef: "tool:failure-diagnostics-test:1:0:call-1",
  scopeRef: identity.scopeRef,
  effectAuthorityRef: { authorityId: "tool:write_file", authorityClass: "write" },
  originRef: { originId: "run:1", originKind: "submit" },
  rejectionRef: {
    rejectionId: "tool.rejected:tool:failure-diagnostics-test:1:0:call-1",
    rejectionKind: "validation_failed",
    reason,
  },
});

const ledgerEvent = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/runtime",
  payload: spec.payload,
});

describe("projectFailureDiagnostics", () => {
  it("folds structured tool rejection diagnostics without exposing raw args", () => {
    const events = [
      ledgerEvent(
        1,
        toolRejectedEvent({
          ...identity,
          runId: 1,
          toolCallId: "call-1",
          name: "write_file",
          args: { type: "object", keys: ["path"], truncated: false },
          execution: { kind: "pure" },
          claim: rejectedClaim("invalid_args"),
          diagnostics: {
            phase: "decode",
            reason: "invalid_args",
            argumentSummary: { type: "object", keys: ["path"], truncated: false },
            schemaIssues: [{ path: "$.content", issue: "required" }],
          },
        }),
      ),
      ledgerEvent(
        2,
        agentRunAbortedEvent({
          ...identity,
          kind: ABORT.TOOL_ERROR,
          runId: 1,
          tokensUsed: 0,
          payload: { toolName: "write_file", cause: "invalid_args" },
        }),
      ),
    ];

    expect(projectFailureDiagnostics(events, 1)).toEqual({
      runId: 1,
      terminalReason: "tool_error",
      diagnostics: [
        {
          source: "tool",
          eventId: 1,
          phase: "decode",
          reason: "invalid_args",
          toolName: "write_file",
          toolCallId: "call-1",
          argumentSummary: { type: "object", keys: ["path"], truncated: false },
          schemaIssues: [{ path: "$.content", issue: "required" }],
        },
      ],
    });
    expect(JSON.stringify(projectFailureDiagnostics(events, 1))).not.toContain("secret-content");
  });

  it("projects unknown tool from terminal abort without fabricating a tool claim", () => {
    const events = [
      ledgerEvent(
        1,
        agentRunAbortedEvent({
          ...identity,
          kind: ABORT.TOOL_ERROR,
          runId: 1,
          tokensUsed: 0,
          payload: { toolName: "missing_tool", cause: "unknown_tool" },
        }),
      ),
    ];

    expect(projectFailureDiagnostics(events, 1)).toEqual({
      runId: 1,
      terminalReason: "tool_error",
      diagnostics: [
        {
          source: "run",
          eventId: 1,
          phase: "terminal",
          reason: "unknown_tool",
          toolName: "missing_tool",
        },
      ],
    });
  });
});
