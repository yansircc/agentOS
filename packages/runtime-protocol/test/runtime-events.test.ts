import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import {
  resolveToolExecution,
  type ExecutionDomainDeclaration,
  type ResolvedToolExecution,
  type ToolExecution,
} from "@agent-os/kernel/tools";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON,
  llmRequestedEvent,
  llmResponseEvent,
  RUNTIME_ABORT_EVENT_KINDS,
  runtimeCompletedAfterToolsEvent,
  replayToolFromArtifact,
  replayToolResultFromSnapshot,
  receiptBackedToolResult,
  receiptBackedToolResultFromUnknown,
  toolReplayArtifactFromExecutedPayload,
  toolExecutedEvent,
  toolResultSnapshotFromExecutedPayload,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "../src/runtime-events";
import { projectRuntimeSafeLedgerEvent } from "../src/safe-events";

const scope = "runtime-event-test";
const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};
const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});
const traceContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

const resolvedToolExecution = (
  execution: ToolExecution,
  domains: ReadonlyArray<ExecutionDomainDeclaration> = [],
): ResolvedToolExecution => {
  const resolved = resolveToolExecution(execution, { domains });
  if (!resolved.ok) {
    throw new Error(`expected resolved tool execution: ${JSON.stringify(resolved.issues)}`);
  }
  return resolved.resolved;
};

const livedClaim: LivedClaim = {
  phase: "lived",
  operationRef: "tool:runtime-event-test:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  anchorRef: {
    anchorId: "tool.executed:tool:runtime-event-test:1:0:call-1",
    anchorKind: "carrier_proof",
    carrierRef: "tool:lookup",
  },
};

const receiptBackedLivedClaim: LivedClaim = {
  ...livedClaim,
  anchorRef: {
    anchorId: "receipt:tool:runtime-event-test:1:0:call-1",
    anchorKind: "external_receipt",
  },
};

const rejectedClaim: RejectedClaim = {
  phase: "rejected",
  operationRef: "tool:runtime-event-test:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  rejectionRef: {
    rejectionId: "tool.rejected:tool:runtime-event-test:1:0:call-1",
    rejectionKind: "provider_rejected",
    reason: "tool_error",
  },
};

const ledgerEvent = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const rawEvent = (id: number, kind: string, payload: unknown): LedgerEvent => ({
  id,
  ts: id * 10,
  kind,
  ...eventIdentity(scope),
  payload,
});

describe("runtime event vocabulary", () => {
  it("round-trips every runtime constructor through the runtime decoder", () => {
    const specs: RuntimeEventCommitSpec[] = [
      agentRunStartedEvent({ ...runtimeIdentity, intent: "answer", traceContext }),
      chatIngestedEvent({
        ...runtimeIdentity,
        runId: 1,
        intent: "answer",
        context: { topic: "runtime" },
        traceContext,
      }),
      llmRequestedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        modelId: "test-model",
        toolNames: ["read_file", "write_file"],
        toolChoice: "required",
        traceContext,
      }),
      agentRunInterruptedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        interruptId: "interrupt-1",
        reason: "decision_required",
        resumeSchema: { type: "object", required: ["approved"] },
        tokensUsed: 3,
        traceContext,
      }),
      agentRunResumedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        interruptId: "interrupt-1",
        resume: { approved: true },
        resumedAtEventId: 3,
        traceContext,
      }),
      llmResponseEvent({
        ...runtimeIdentity,
        turn: { id: 1, index: 0 },
        items: [
          { type: "message", text: "use lookup" },
          {
            type: "tool_call",
            call: {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        traceContext,
      }),
      toolExecutedEvent({
        ...runtimeIdentity,
        runId: 1,
        toolCallId: "call-1",
        name: "lookup",
        args: '{"q":"x"}',
        execution: { kind: "deterministic" },
        result: { ok: true },
        claim: livedClaim,
        traceContext,
      }),
      toolRejectedEvent({
        ...runtimeIdentity,
        runId: 1,
        toolCallId: "call-1",
        name: "lookup",
        args: '{"q":"x"}',
        execution: { kind: "deterministic" },
        claim: rejectedClaim,
        traceContext,
      }),
      agentRunCompletedEvent({
        ...runtimeIdentity,
        runId: 1,
        final: "done",
        output: "done",
        outputKind: "text",
        tokensUsed: 3,
        traceContext,
      }),
      runtimeCompletedAfterToolsEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        toolNames: ["write_file"],
        tokensUsed: 5,
        traceContext,
      }),
      ...RUNTIME_ABORT_EVENT_KINDS.map((kind) =>
        agentRunAbortedEvent({
          ...runtimeIdentity,
          kind,
          runId: 1,
          tokensUsed: 3,
          payload: { reason: kind.replace(/^agent\.aborted\./, "") },
          traceContext,
        }),
      ),
    ];

    for (const [index, spec] of specs.entries()) {
      const decoded = decodeRuntimeLedgerEvent(ledgerEvent(index + 1, spec));
      expect(decoded._tag).toBe("runtime");
      if (decoded._tag === "runtime") {
        expect(decoded.event.kind).toBe(spec.kind);
        expect(decoded.event.payload).toEqual(spec.payload);
      }
    }
  });

  it("projects LLM and complete-after-tools runtime facts without prompt or args", () => {
    const requested = ledgerEvent(
      1,
      llmRequestedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        modelId: "claude-sonnet-4-6",
        toolNames: ["read_file", "write_editor_patch_candidate"],
        toolChoice: "required",
      }),
    );
    const completedAfterTools = ledgerEvent(
      2,
      runtimeCompletedAfterToolsEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        toolNames: ["write_editor_patch_candidate"],
        tokensUsed: 42,
      }),
    );

    expect(projectRuntimeSafeLedgerEvent(requested)?.safePayload).toEqual({
      runId: 1,
      turnIndex: 0,
      modelId: "claude-sonnet-4-6",
      toolNames: ["read_file", "write_editor_patch_candidate"],
      toolChoice: "required",
    });
    expect(projectRuntimeSafeLedgerEvent(completedAfterTools)?.safePayload).toEqual({
      runId: 1,
      turnIndex: 0,
      toolNames: ["write_editor_patch_candidate"],
      tokensUsed: 42,
    });
    expect(JSON.stringify(projectRuntimeSafeLedgerEvent(requested))).not.toContain("prompt");
    expect(JSON.stringify(projectRuntimeSafeLedgerEvent(requested))).not.toContain("args");
  });

  it("projects safe tool io summaries without raw arguments or file content", () => {
    const toolStarted = ledgerEvent(
      1,
      llmResponseEvent({
        ...runtimeIdentity,
        turn: { id: 1, index: 0 },
        items: [
          {
            type: "tool_call",
            call: {
              id: "call-read",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"/input/request.json"}',
              },
            },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    );
    const toolCompleted = ledgerEvent(
      2,
      toolExecutedEvent({
        ...runtimeIdentity,
        runId: 1,
        toolCallId: "call-write",
        name: "write_editor_patch_candidate",
        args: '{"content":"SECRET_CODE"}',
        execution: { kind: "deterministic" },
        result: {
          path: "/output/code.fragment",
          bytesWritten: 42,
          metadataPath: "/output/candidate-result.json",
          metadataBytesWritten: 12,
        },
        claim: livedClaim,
      }),
    );

    expect(projectRuntimeSafeLedgerEvent(toolStarted)?.safePayload).toMatchObject({
      items: [
        {
          type: "tool_call",
          toolCallId: "call-read",
          toolName: "read_file",
          io: [{ action: "read", path: "/input/request.json" }],
        },
      ],
    });
    expect(projectRuntimeSafeLedgerEvent(toolCompleted)?.safePayload).toMatchObject({
      runId: 1,
      toolCallId: "call-write",
      toolName: "write_editor_patch_candidate",
      io: [
        { action: "write", path: "/output/code.fragment", bytes: 42 },
        {
          action: "write",
          path: "/output/candidate-result.json",
          bytes: 12,
          role: "metadata",
        },
      ],
    });
    const safeText = JSON.stringify([
      projectRuntimeSafeLedgerEvent(toolStarted),
      projectRuntimeSafeLedgerEvent(toolCompleted),
    ]);
    expect(safeText).not.toContain("SECRET_CODE");
    expect(safeText).not.toContain("content");
  });

  it("reports product deliver events as non-runtime unknown payloads", () => {
    const decoded = decodeRuntimeLedgerEvent(rawEvent(1, "answer.ready", { final: "done" }));
    expect(decoded).toMatchObject({ _tag: "non_runtime" });
  });

  it("replay mode tool execute not called: deterministic tool result replays from snapshot", () => {
    let liveToolExecuteCalled = false;
    const liveTool = {
      execute: () => {
        liveToolExecuteCalled = true;
        throw new Error("live tool execute should not be called in replay");
      },
    };
    const payload = toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "lookup",
      args: { q: "x" },
      execution: { kind: "deterministic" },
      result: { ok: true },
      claim: livedClaim,
      traceContext,
    }).payload;

    const snapshot = toolResultSnapshotFromExecutedPayload(
      {
        ...payload,
        execution: { kind: "deterministic" },
        claim: livedClaim,
      },
      resolvedToolExecution({ kind: "deterministic" }),
    );
    const replayed = replayToolResultFromSnapshot(snapshot);

    expect(replayed).toEqual({ ok: true, result: { ok: true }, claim: livedClaim });
    expect(liveToolExecuteCalled).toBe(false);
    expect(liveTool.execute).toBeDefined();
  });

  it("does not build a raw result snapshot for an external tool without a receipt", () => {
    const execution = {
      kind: "external",
      access: "write",
      domain: { kind: "workspace", ref: "workspace:default" },
    } as const;
    const payload = toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "write_file",
      args: { path: "out.txt" },
      execution,
      result: { written: true },
      claim: livedClaim,
    }).payload;

    const resolved = resolvedToolExecution(execution, [
      { domain: execution.domain, replay: { access: "write", witness: "receipt" } },
    ]);

    expect(toolReplayArtifactFromExecutedPayload(payload, resolved)).toEqual({
      ok: false,
      reason: EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON,
      execution: {
        kind: "external",
        access: "write",
        domain: { kind: "workspace", ref: "workspace:default" },
      },
      claim: livedClaim,
    });
  });

  it("replays receipt-backed external tool execution from the receipt artifact", () => {
    const execution = {
      kind: "external",
      access: "write",
      domain: { kind: "workspace", ref: "workspace:default" },
    } as const;
    const payload = toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "write_file",
      args: { path: "out.txt" },
      execution,
      result: { written: true },
      claim: receiptBackedLivedClaim,
      traceContext,
    }).payload;

    const resolved = resolvedToolExecution(execution, [
      { domain: execution.domain, replay: { access: "write", witness: "receipt" } },
    ]);

    const artifact = toolReplayArtifactFromExecutedPayload(payload, resolved);
    expect(artifact).toMatchObject({
      ok: true,
      artifact: {
        kind: "tool.execution.receipt",
        idempotencyKey: receiptBackedLivedClaim.operationRef,
        receipt: receiptBackedLivedClaim.anchorRef,
      },
    });
    if (!artifact.ok) {
      expect.fail("expected receipt-backed external tool replay artifact");
    }

    expect(replayToolFromArtifact(artifact.artifact)).toEqual({
      ok: true,
      result: { written: true },
      claim: receiptBackedLivedClaim,
      idempotencyKey: receiptBackedLivedClaim.operationRef,
      receipt: receiptBackedLivedClaim.anchorRef,
    });
  });

  it("validates receipt-backed bridge results before runtime logs tool.executed", () => {
    const result = receiptBackedToolResult({
      result: { kind: "write_file", path: "out.txt", bytesWritten: 4 },
      claim: receiptBackedLivedClaim,
    });

    expect(receiptBackedToolResultFromUnknown(result)).toEqual(result);
    expect(
      receiptBackedToolResultFromUnknown({
        ...result,
        claim: livedClaim,
      }),
    ).toBeNull();
    expect(() =>
      receiptBackedToolResult({
        result: { ok: true },
        claim: livedClaim,
      }),
    ).toThrow("external_receipt");
  });

  it("rejects missing required runtime payload fields", () => {
    expect(() => decodeRuntimeLedgerEvent(rawEvent(1, "agent.run.started", {}))).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(2, "llm.response", { turn: { id: 1, index: 0 } })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(3, "tool.executed", { runId: 1, name: "lookup" })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(4, "tool.rejected", { runId: 1, name: "lookup" })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(5, "agent.run.completed", { final: "done" })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(6, "agent.aborted.tool_error", { reason: "tool_error" })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(7, "agent.run.interrupted", {
          runId: 1,
          turn: { id: 2, index: 0 },
          interruptId: "interrupt-1",
          reason: "decision_required",
          resumeSchema: {},
          tokensUsed: 0,
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(8, "agent.run.resumed", {
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "",
          resume: {},
          resumedAtEventId: 7,
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(9, "agent.run.started", {
          intent: "answer",
          traceContext: { traceparent: "00-test" },
        }),
      ),
    ).toThrow();
  });
});
