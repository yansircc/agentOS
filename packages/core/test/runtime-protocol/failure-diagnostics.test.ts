import { describe, expect, it } from "@effect/vitest";
import { ABORT } from "@agent-os/core/abort";
import type { LedgerEvent } from "@agent-os/core/types";
import type { RejectedClaim } from "@agent-os/core/effect-claim";
import {
  agentRunAbortedEvent,
  EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
  projectFailureDiagnostics,
  RUNTIME_FACT_OWNER,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "../../src/runtime-protocol";

const scope = "failure-diagnostics-test";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const rejectedClaim = (reason: string): RejectedClaim => ({
  phase: "rejected",
  operationRef: "tool:failure-diagnostics-test:1:0:call-1",
  scopeRef: identity.scopeRef,
  effectAuthorityRef: {
    authorityId: "tool:write_file",
    authorityClass: "write",
  },
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
  factOwnerRef: RUNTIME_FACT_OWNER,
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
          execution: { kind: "deterministic" },
          claim: rejectedClaim("invalid_args"),
          diagnostics: {
            phase: "decode",
            reason: "invalid_args",
            argumentSummary: {
              type: "object",
              keys: ["path"],
              truncated: false,
            },
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
          category: "invalid_args",
          owner: "model",
          retryable: true,
          publicMessage: "Tool arguments did not match the tool schema.",
          internalFacts: {
            source: "tool",
            eventId: 1,
            phase: "decode",
            reason: "invalid_args",
            toolName: "write_file",
            toolCallId: "call-1",
            argumentSummary: {
              type: "object",
              keys: ["path"],
              truncated: false,
            },
            schemaIssues: [{ path: "$.content", issue: "required" }],
          },
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
          category: "unknown_tool",
          owner: "model",
          retryable: true,
          publicMessage: "The model requested a tool that is not available.",
          internalFacts: {
            source: "run",
            eventId: 1,
            phase: "terminal",
            reason: "unknown_tool",
            terminalReason: "tool_error",
            toolName: "missing_tool",
          },
          toolName: "missing_tool",
        },
      ],
    });
  });

  it("projects symbolic provider cause from upstream terminal abort", () => {
    const events = [
      ledgerEvent(
        1,
        agentRunAbortedEvent({
          ...identity,
          kind: ABORT.UPSTREAM_FAILURE,
          runId: 1,
          tokensUsed: 0,
          payload: {
            cause: "provider_http_failure:openrouter:http_400:schema",
            rawMessage: "InternalError.Algo.InvalidParameter secret provider detail",
          },
        }),
      ),
    ];

    expect(projectFailureDiagnostics(events, 1)).toEqual({
      runId: 1,
      terminalReason: "upstream_failure",
      diagnostics: [
        {
          source: "run",
          eventId: 1,
          phase: "terminal",
          reason: "provider_http_failure:openrouter:http_400:schema",
          category: "provider_failure",
          owner: "provider",
          retryable: true,
          publicMessage: "The upstream provider failed or timed out.",
          internalFacts: {
            source: "run",
            eventId: 1,
            phase: "terminal",
            reason: "provider_http_failure:openrouter:http_400:schema",
            terminalReason: "upstream_failure",
          },
        },
      ],
    });
    expect(JSON.stringify(projectFailureDiagnostics(events, 1))).not.toContain(
      "InternalError.Algo",
    );
    expect(JSON.stringify(projectFailureDiagnostics(events, 1))).not.toContain("secret");
  });

  it("classifies missing receipt-backed execution path without hard-coded consumer owner", () => {
    const events = [
      ledgerEvent(
        1,
        toolRejectedEvent({
          ...identity,
          runId: 1,
          toolCallId: "call-1",
          name: "write_file",
          args: { type: "object", keys: ["path"], truncated: false },
          execution: {
            kind: "external",
            access: "write",
            domain: { kind: "workspace", ref: "workspace:default" },
          },
          claim: rejectedClaim(EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON),
        }),
      ),
      ledgerEvent(
        2,
        agentRunAbortedEvent({
          ...identity,
          kind: ABORT.TOOL_ERROR,
          runId: 1,
          tokensUsed: 0,
          payload: {
            toolName: "write_file",
            cause: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
          },
        }),
      ),
    ];

    expect(projectFailureDiagnostics(events, 1)).toMatchObject({
      runId: 1,
      terminalReason: "tool_error",
      diagnostics: [
        {
          source: "tool",
          reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
          category: "missing_execution_path",
          owner: "integrator",
          retryable: false,
          publicMessage: "This tool requires a receipt-backed execution path before it can run.",
          internalFacts: {
            source: "tool",
            reason: EXTERNAL_TOOL_EXECUTION_REQUIRES_RECEIPT_REASON,
            toolName: "write_file",
            toolCallId: "call-1",
          },
        },
      ],
    });
  });
});
