import { describe, expect, it } from "@effect/vitest";
import type { Recorded } from "@agent-os/core";
import type { LedgerEvent } from "@agent-os/core/types";
import type { LivedClaim, RejectedClaim } from "@agent-os/core/effect-claim";
import {
  resolveToolExecution,
  type ExecutionDomainDeclaration,
  type ResolvedToolExecution,
  type ToolExecution,
} from "@agent-os/core/tools";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  agentSessionTurnSubmittedEvent,
  chatIngestedEvent,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON,
  llmRequestedEvent,
  llmResponseEvent,
  RUNTIME_ABORT_EVENT_KINDS,
  runtimeCompletedAfterToolsEvent,
  runtimeHistoryCompactedEvent,
  runtimeRekeyedEvent,
  replayToolFromArtifact,
  replayToolResultFromSnapshot,
  receiptBackedToolResult,
  receiptBackedToolResultFromUnknown,
  toolReplayArtifactFromExecutedPayload,
  toolExecutedEvent,
  toolResultSnapshotFromExecutedPayload,
  toolRejectedEvent,
  validateRuntimeLedgerTransitions,
  workflowRunSubmittedEvent,
  type RuntimeEventCommitSpec,
} from "../../src/runtime-protocol/runtime-events";
import {
  EXECUTION_IDENTITY_VERSION,
  type ExecutionIdentity,
} from "../../src/runtime-protocol/execution-identity";
import { projectRuntimeSafeLedgerEvent } from "../../src/runtime-protocol/safe-events";

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
const executionIdentity: ExecutionIdentity = {
  version: EXECUTION_IDENTITY_VERSION,
  manifest: {
    agentId: "agent.runtime-event-test",
    version: "1.0.0",
    outputSchemaFingerprint: "agent-schema-v1:sha256:runtime-output",
  },
  deployment: {
    deploymentId: "deployment:runtime-event-test",
    backend: "cloudflare-do",
    adapter: "sse-http",
    codec: "ledger-v1",
    providerStrategy: "effect-ai",
  },
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

const llmResponseWithToolCall = (
  turn: { readonly id: number; readonly index: number } = { id: 1, index: 0 },
): RuntimeEventCommitSpec =>
  llmResponseEvent({
    ...runtimeIdentity,
    turn,
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
  });

describe("runtime event vocabulary", () => {
  it("round-trips every runtime constructor through the runtime decoder", () => {
    const specs: RuntimeEventCommitSpec[] = [
      agentRunStartedEvent({
        ...runtimeIdentity,
        intent: "answer",
        executionIdentity,
        traceContext,
      }),
      chatIngestedEvent({
        ...runtimeIdentity,
        runId: 1,
        intent: "answer",
        context: { topic: "runtime" },
        traceContext,
      }),
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
        runtimeRunId: 1,
        traceContext,
      }),
      workflowRunSubmittedEvent({
        ...runtimeIdentity,
        workflowId: "summarize",
        workflowRunId: "workflow-run:1",
        runtimeRunId: 1,
        idempotencyKey: "idem:1",
        inputDigest: "sha256:input",
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
        resume: { kind: "approval", approved: true },
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
      runtimeHistoryCompactedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        sourceEventId: 6,
        toolCallId: "call-1",
        toolName: "lookup",
        originalBytes: 2048,
        compactedBytes: 96,
        traceContext,
      }),
      runtimeRekeyedEvent({
        ...runtimeIdentity,
        runId: 1,
        sourceEventId: 7,
        sourceKeyRef: "key:old",
        targetKeyRef: "key:new",
        purpose: "replay-artifact",
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

  it("mints Recorded runtime facts without changing the serialized shape", () => {
    const spec = agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" });
    const recordedSpec: Recorded<typeof spec.value> = spec;

    expect(recordedSpec.value.kind).toBe("agent.run.started");
    expect(Object.prototype.propertyIsEnumerable.call(spec, "value")).toBe(false);
    expect(JSON.stringify(spec)).not.toContain('"value"');

    const decoded = decodeRuntimeLedgerEvent(ledgerEvent(1, spec));
    if (decoded._tag !== "runtime") expect.fail("expected runtime event");
    const recordedEvent: Recorded<typeof decoded.event.value> = decoded.event;

    expect(recordedEvent.value.kind).toBe("agent.run.started");
    expect(Object.prototype.propertyIsEnumerable.call(decoded.event, "value")).toBe(false);
    expect(JSON.stringify(decoded.event)).not.toContain('"value"');
  });

  it("carries execution identity on run start and rejects malformed provenance", () => {
    const spec = agentRunStartedEvent({ ...runtimeIdentity, intent: "answer", executionIdentity });

    expect(spec.payload.executionIdentity).toEqual(executionIdentity);
    expect(decodeRuntimeLedgerEvent(ledgerEvent(1, spec))).toMatchObject({
      _tag: "runtime",
      event: {
        payload: { executionIdentity },
      },
    });
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(1, "agent.run.started", {
          intent: "answer",
          executionIdentity: {
            ...executionIdentity,
            deployment: { ...executionIdentity.deployment, adapter: "" },
          },
        }),
      ),
    ).toThrow();
  });

  it("records product lifecycle links without terminal truth or execution identity overload", () => {
    const sessionTurn = ledgerEvent(
      2,
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
        runtimeRunId: 1,
      }),
    );
    const workflowRun = ledgerEvent(
      3,
      workflowRunSubmittedEvent({
        ...runtimeIdentity,
        workflowId: "summarize",
        workflowRunId: "workflow-run:1",
        runtimeRunId: 1,
        idempotencyKey: "idem:1",
        inputDigest: "sha256:input",
      }),
    );

    expect(projectRuntimeSafeLedgerEvent(sessionTurn)?.safePayload).toEqual({
      sessionRef: "session:s1",
      turnRef: "turn:s1:1",
      runtimeRunId: 1,
    });
    expect(projectRuntimeSafeLedgerEvent(workflowRun)?.safePayload).toEqual({
      workflowId: "summarize",
      workflowRunId: "workflow-run:1",
      runtimeRunId: 1,
      idempotencyKey: "idem:1",
      inputDigest: "sha256:input",
    });
    const serialized = JSON.stringify([sessionTurn, workflowRun]);
    expect(serialized).not.toContain("status");
    expect(serialized).not.toContain("terminal");
    expect(serialized).not.toContain("executionIdentity");
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

  it("projects compaction and rekey facts as append-only references", () => {
    const compaction = ledgerEvent(
      3,
      runtimeHistoryCompactedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        sourceEventId: 2,
        toolCallId: "call-1",
        toolName: "write_file",
        originalBytes: 4096,
        compactedBytes: 128,
      }),
    );
    const rekey = ledgerEvent(
      4,
      runtimeRekeyedEvent({
        ...runtimeIdentity,
        runId: 1,
        sourceEventId: 3,
        sourceKeyRef: "key:old",
        targetKeyRef: "key:new",
        purpose: "replay-artifact",
      }),
    );

    expect(projectRuntimeSafeLedgerEvent(compaction)?.safePayload).toEqual({
      runId: 1,
      turnIndex: 0,
      sourceEventId: 2,
      target: {
        kind: "tool_call_arguments",
        toolCallId: "call-1",
        toolName: "write_file",
      },
      strategy: "provider_history_string_redaction",
      originalBytes: 4096,
      compactedBytes: 128,
    });
    expect(projectRuntimeSafeLedgerEvent(rekey)?.safePayload).toEqual({
      runId: 1,
      sourceEventId: 3,
      sourceKeyRef: "key:old",
      targetKeyRef: "key:new",
      purpose: "replay-artifact",
    });
    expect(JSON.stringify(projectRuntimeSafeLedgerEvent(compaction))).not.toContain("SECRET_CODE");
  });

  it("does not infer safe tool io from tool names or product-shaped fields", () => {
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
        },
      ],
    });
    expect(projectRuntimeSafeLedgerEvent(toolCompleted)?.safePayload).toMatchObject({
      runId: 1,
      toolCallId: "call-write",
      toolName: "write_editor_patch_candidate",
    });
    expect(projectRuntimeSafeLedgerEvent(toolStarted)?.safePayload).not.toHaveProperty(
      "items.0.io",
    );
    expect(projectRuntimeSafeLedgerEvent(toolCompleted)?.safePayload).not.toHaveProperty("io");
    const safeText = JSON.stringify([
      projectRuntimeSafeLedgerEvent(toolStarted),
      projectRuntimeSafeLedgerEvent(toolCompleted),
    ]);
    expect(safeText).not.toContain("SECRET_CODE");
    expect(safeText).not.toContain("content");
  });

  it("reports product deliver events as non-runtime unknown payloads", () => {
    const event = rawEvent(1, "answer.ready", { final: "done" });
    const decoded = decodeRuntimeLedgerEvent(event);
    expect(decoded).toMatchObject({ _tag: "non_runtime" });
    expect(projectRuntimeSafeLedgerEvent(event)).toBeUndefined();
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

  it("validates runtime transition sources against prior and same-batch events", () => {
    const started = ledgerEvent(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }));
    const response = ledgerEvent(2, llmResponseWithToolCall());
    const interrupted = ledgerEvent(
      3,
      agentRunInterruptedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        interruptId: "interrupt-1",
        reason: "decision_required",
        resumeSchema: { type: "object" },
        tokensUsed: 3,
        decision: {
          gateRef: "gate:1",
          subjectRef: "tool:lookup",
          toolCallId: "call-1",
          toolName: "lookup",
        },
      }),
    );
    const consumed = rawEvent(4, "decision_gate.consumed", {
      gateRef: "gate:1",
      decisionRef: "decision:1",
      consumedBy: "runtime",
      claim: { phase: "lived" },
    });
    const history = [started, response, interrupted, consumed];
    const compaction = ledgerEvent(
      5,
      runtimeHistoryCompactedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        sourceEventId: 2,
        toolCallId: "call-1",
        toolName: "lookup",
        originalBytes: 256,
        compactedBytes: 16,
      }),
    );
    const rekey = ledgerEvent(
      6,
      runtimeRekeyedEvent({
        ...runtimeIdentity,
        runId: 1,
        sourceEventId: compaction.id,
        sourceKeyRef: "key:old",
        targetKeyRef: "key:new",
        purpose: "compacted-history",
      }),
    );
    const resume = ledgerEvent(
      7,
      agentRunResumedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        interruptId: "interrupt-1",
        resume: { kind: "approval", approved: true },
        resumedAtEventId: consumed.id,
      }),
    );

    expect(
      validateRuntimeLedgerTransitions({ history, events: [compaction, rekey, resume] }),
    ).toEqual({
      ok: true,
    });
  });

  it("accepts product link events only as unique links to a prior runtime run", () => {
    const started = ledgerEvent(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }));
    const sessionTurn = ledgerEvent(
      2,
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
        runtimeRunId: started.id,
      }),
    );
    const workflowRun = ledgerEvent(
      3,
      workflowRunSubmittedEvent({
        ...runtimeIdentity,
        workflowId: "summarize",
        workflowRunId: "workflow-run:1",
        runtimeRunId: started.id,
        idempotencyKey: "idem:1",
        inputDigest: "sha256:input",
      }),
    );

    expect(
      validateRuntimeLedgerTransitions({ history: [started], events: [sessionTurn, workflowRun] }),
    ).toEqual({ ok: true });

    const duplicateSessionTurn = ledgerEvent(
      4,
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
        runtimeRunId: started.id,
      }),
    );
    const duplicateWorkflowRun = ledgerEvent(
      5,
      workflowRunSubmittedEvent({
        ...runtimeIdentity,
        workflowId: "summarize",
        workflowRunId: "workflow-run:1",
        runtimeRunId: started.id,
      }),
    );

    const duplicateValidation = validateRuntimeLedgerTransitions({
      history: [started, sessionTurn, workflowRun],
      events: [duplicateSessionTurn, duplicateWorkflowRun],
    });
    expect(duplicateValidation.ok).toBe(false);
    if (!duplicateValidation.ok) {
      expect(duplicateValidation.issues.map((issue) => issue.code)).toEqual([
        "runtime_product_link_duplicate",
        "runtime_product_link_duplicate",
      ]);
    }
  });

  it("rejects a new session turn while the same session has an active runtime run", () => {
    const firstStarted = ledgerEvent(
      1,
      agentRunStartedEvent({ ...runtimeIdentity, intent: "first turn" }),
    );
    const firstTurn = ledgerEvent(
      2,
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
        runtimeRunId: firstStarted.id,
      }),
    );
    const secondStarted = ledgerEvent(
      3,
      agentRunStartedEvent({ ...runtimeIdentity, intent: "second turn" }),
    );
    const secondTurn = ledgerEvent(
      4,
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:2",
        runtimeRunId: secondStarted.id,
      }),
    );

    const activeConflict = validateRuntimeLedgerTransitions({
      history: [firstStarted, firstTurn, secondStarted],
      events: [secondTurn],
    });

    expect(activeConflict.ok).toBe(false);
    if (!activeConflict.ok) {
      expect(activeConflict.issues.map((issue) => issue.code)).toEqual([
        "runtime_session_active_run_conflict",
      ]);
    }

    const firstCompleted = ledgerEvent(
      5,
      agentRunCompletedEvent({
        ...runtimeIdentity,
        runId: firstStarted.id,
        final: "done",
        output: "done",
        outputKind: "text",
        tokensUsed: 1,
      }),
    );

    expect(
      validateRuntimeLedgerTransitions({
        history: [firstStarted, firstTurn, firstCompleted, secondStarted],
        events: [secondTurn],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects product link events without a prior non-terminal runtime run", () => {
    const started = ledgerEvent(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }));
    const completed = ledgerEvent(
      2,
      agentRunCompletedEvent({
        ...runtimeIdentity,
        runId: started.id,
        final: "done",
        output: "done",
        outputKind: "text",
        tokensUsed: 1,
      }),
    );
    const missingRunLink = ledgerEvent(
      3,
      agentSessionTurnSubmittedEvent({
        ...runtimeIdentity,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
        runtimeRunId: 99,
      }),
    );
    const terminalRunLink = ledgerEvent(
      4,
      workflowRunSubmittedEvent({
        ...runtimeIdentity,
        workflowId: "summarize",
        workflowRunId: "workflow-run:1",
        runtimeRunId: started.id,
      }),
    );

    const missingRunValidation = validateRuntimeLedgerTransitions({
      history: [],
      events: [missingRunLink],
    });
    expect(missingRunValidation.ok).toBe(false);
    if (!missingRunValidation.ok) {
      expect(missingRunValidation.issues.map((issue) => issue.code)).toEqual([
        "runtime_run_missing_start",
      ]);
    }

    const terminalRunValidation = validateRuntimeLedgerTransitions({
      history: [started, completed],
      events: [terminalRunLink],
    });
    expect(terminalRunValidation.ok).toBe(false);
    if (!terminalRunValidation.ok) {
      expect(terminalRunValidation.issues.map((issue) => issue.code)).toEqual([
        "runtime_run_already_terminal",
      ]);
    }
  });

  it("rejects runtime transitions without a proven prior source", () => {
    const wrongKind = ledgerEvent(
      1,
      agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }),
    );
    const wrongTurn = ledgerEvent(2, llmResponseWithToolCall({ id: 2, index: 0 }));
    const events = [
      ledgerEvent(
        10,
        runtimeHistoryCompactedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          sourceEventId: 3,
          toolCallId: "call-1",
          toolName: "lookup",
          originalBytes: 256,
          compactedBytes: 16,
        }),
      ),
      ledgerEvent(
        11,
        runtimeHistoryCompactedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          sourceEventId: 11,
          toolCallId: "call-1",
          toolName: "lookup",
          originalBytes: 256,
          compactedBytes: 16,
        }),
      ),
      ledgerEvent(
        12,
        runtimeHistoryCompactedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          sourceEventId: 1,
          toolCallId: "call-1",
          toolName: "lookup",
          originalBytes: 256,
          compactedBytes: 16,
        }),
      ),
      ledgerEvent(
        13,
        runtimeHistoryCompactedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          sourceEventId: 2,
          toolCallId: "call-1",
          toolName: "lookup",
          originalBytes: 256,
          compactedBytes: 16,
        }),
      ),
      ledgerEvent(
        14,
        agentRunResumedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "interrupt-1",
          resume: { kind: "approval", approved: true },
          resumedAtEventId: 14,
        }),
      ),
      ledgerEvent(
        15,
        agentRunResumedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "interrupt-1",
          resume: { kind: "approval", approved: true },
          resumedAtEventId: 9,
        }),
      ),
      ledgerEvent(
        16,
        agentRunResumedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "interrupt-1",
          resume: { kind: "approval", approved: true },
          resumedAtEventId: 1,
        }),
      ),
    ];
    const validation = validateRuntimeLedgerTransitions({
      history: [wrongKind, wrongTurn],
      events,
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code)).toEqual([
      "runtime_source_event_missing",
      "runtime_source_event_not_before",
      "runtime_compaction_source_kind_mismatch",
      "runtime_compaction_source_turn_mismatch",
      "runtime_source_event_not_before",
      "runtime_resume_interruption_missing",
      "runtime_source_event_missing",
      "runtime_resume_interruption_missing",
      "runtime_resume_consumed_event_kind_mismatch",
      "runtime_resume_interruption_missing",
    ]);
  });

  it("rejects resume without a prior started and interrupted run state", () => {
    const consumed = rawEvent(1, "decision_gate.consumed", {
      gateRef: "gate:1",
      decisionRef: "decision:1",
      consumedBy: "runtime",
      claim: { phase: "lived" },
    });
    const resume = ledgerEvent(
      2,
      agentRunResumedEvent({
        ...runtimeIdentity,
        runId: 1,
        turn: { id: 1, index: 0 },
        interruptId: "interrupt-1",
        resume: { kind: "approval", approved: true },
        resumedAtEventId: consumed.id,
      }),
    );

    const validation = validateRuntimeLedgerTransitions({ history: [consumed], events: [resume] });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code)).toEqual([
      "runtime_run_missing_start",
      "runtime_resume_interruption_missing",
    ]);
  });

  it("rejects runtime facts after terminal run state", () => {
    const started = ledgerEvent(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }));
    const completed = ledgerEvent(
      2,
      agentRunCompletedEvent({
        ...runtimeIdentity,
        runId: started.id,
        final: "done",
        output: "done",
        outputKind: "text",
        tokensUsed: 1,
      }),
    );
    const aborted = ledgerEvent(
      3,
      agentRunAbortedEvent({
        ...runtimeIdentity,
        kind: RUNTIME_ABORT_EVENT_KINDS[0]!,
        runId: started.id,
        tokensUsed: 1,
        payload: { reason: "late" },
      }),
    );

    const validation = validateRuntimeLedgerTransitions({
      history: [started, completed],
      events: [aborted],
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code)).toEqual([
      "runtime_run_duplicate_terminal",
    ]);
  });

  it("rejects duplicate starts and duplicate interruption resumes", () => {
    const started = ledgerEvent(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }));
    const interrupted = ledgerEvent(
      2,
      agentRunInterruptedEvent({
        ...runtimeIdentity,
        runId: started.id,
        turn: { id: started.id, index: 0 },
        interruptId: "interrupt-1",
        reason: "decision_required",
        resumeSchema: { type: "object" },
        tokensUsed: 1,
      }),
    );
    const consumed = rawEvent(3, "decision_gate.consumed", {
      gateRef: "gate:1",
      decisionRef: "decision:1",
      consumedBy: "runtime",
      claim: { phase: "lived" },
    });
    const resumed = ledgerEvent(
      4,
      agentRunResumedEvent({
        ...runtimeIdentity,
        runId: started.id,
        turn: { id: started.id, index: 0 },
        interruptId: "interrupt-1",
        resume: { kind: "approval", approved: true },
        resumedAtEventId: consumed.id,
      }),
    );
    const secondConsumed = rawEvent(5, "decision_gate.consumed", {
      gateRef: "gate:1",
      decisionRef: "decision:2",
      consumedBy: "runtime",
      claim: { phase: "lived" },
    });
    const secondResume = ledgerEvent(
      6,
      agentRunResumedEvent({
        ...runtimeIdentity,
        runId: started.id,
        turn: { id: started.id, index: 0 },
        interruptId: "interrupt-1",
        resume: { kind: "approval", approved: true },
        resumedAtEventId: secondConsumed.id,
      }),
    );
    const duplicateStart = ledgerEvent(
      started.id,
      agentRunStartedEvent({ ...runtimeIdentity, intent: "duplicate" }),
    );

    const duplicateStartValidation = validateRuntimeLedgerTransitions({
      history: [started],
      events: [duplicateStart],
    });
    expect(duplicateStartValidation.ok).toBe(false);
    if (!duplicateStartValidation.ok) {
      expect(duplicateStartValidation.issues.map((issue) => issue.code)).toEqual([
        "runtime_run_duplicate_start",
      ]);
    }

    const duplicateResumeValidation = validateRuntimeLedgerTransitions({
      history: [started, interrupted, consumed, resumed],
      events: [secondConsumed, secondResume],
    });
    expect(duplicateResumeValidation.ok).toBe(false);
    if (!duplicateResumeValidation.ok) {
      expect(duplicateResumeValidation.issues.map((issue) => issue.code)).toEqual([
        "runtime_resume_interruption_already_consumed",
      ]);
    }
  });

  it("rejects resume authorized by the wrong consumed gate", () => {
    const started = ledgerEvent(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "answer" }));
    const interrupted = ledgerEvent(
      2,
      agentRunInterruptedEvent({
        ...runtimeIdentity,
        runId: started.id,
        turn: { id: started.id, index: 0 },
        interruptId: "interrupt-1",
        reason: "decision_required",
        resumeSchema: { type: "object" },
        tokensUsed: 1,
        decision: {
          gateRef: "gate:expected",
          subjectRef: "tool:lookup",
          toolCallId: "call-1",
          toolName: "lookup",
        },
      }),
    );
    const consumed = rawEvent(3, "decision_gate.consumed", {
      gateRef: "gate:other",
      decisionRef: "decision:1",
      consumedBy: "runtime",
      claim: { phase: "lived" },
    });
    const resume = ledgerEvent(
      4,
      agentRunResumedEvent({
        ...runtimeIdentity,
        runId: started.id,
        turn: { id: started.id, index: 0 },
        interruptId: "interrupt-1",
        resume: { kind: "approval", approved: true },
        resumedAtEventId: consumed.id,
      }),
    );

    const validation = validateRuntimeLedgerTransitions({
      history: [started, interrupted, consumed],
      events: [resume],
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.map((issue) => issue.code)).toEqual([
      "runtime_resume_consumed_gate_mismatch",
    ]);
  });

  it("rejects missing required runtime payload fields", () => {
    expect(() => decodeRuntimeLedgerEvent(rawEvent(1, "agent.run.started", {}))).toThrow();
    expect(() => projectRuntimeSafeLedgerEvent(rawEvent(1, "agent.run.started", {}))).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(2, "llm.response", { turn: { id: 1, index: 0 } })),
    ).toThrow();
    expect(() =>
      projectRuntimeSafeLedgerEvent(rawEvent(2, "llm.response", { turn: { id: 1, index: 0 } })),
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
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(10, "runtime.history_compacted", {
          runId: 1,
          turn: { id: 1, index: 0 },
          sourceEventId: 2,
          target: { kind: "tool_call_arguments", toolCallId: "call-1", toolName: "lookup" },
          strategy: "provider_history_string_redaction",
          originalBytes: 64,
          compactedBytes: 64,
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(11, "runtime.rekeyed", {
          runId: 1,
          sourceEventId: 10,
          sourceKeyRef: "key:same",
          targetKeyRef: "key:same",
          purpose: "replay-artifact",
        }),
      ),
    ).toThrow();
  });
});
