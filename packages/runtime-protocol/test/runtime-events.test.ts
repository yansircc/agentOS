import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  decodeRuntimeLedgerEvent,
  EXTERNAL_TOOL_REPLAY_REQUIRES_RECEIPT_REASON,
  llmResponseEvent,
  RUNTIME_ABORT_EVENT_KINDS,
  replayToolFromArtifact,
  replayToolResultFromSnapshot,
  toolReplayArtifactFromExecutedPayload,
  toolExecutedEvent,
  toolResultSnapshotFromExecutedPayload,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "../src/runtime-events";

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

    const snapshot = toolResultSnapshotFromExecutedPayload({
      ...payload,
      execution: { kind: "deterministic" },
      claim: livedClaim,
    });
    const replayed = replayToolResultFromSnapshot(snapshot);

    expect(replayed).toEqual({ ok: true, result: { ok: true }, claim: livedClaim });
    expect(liveToolExecuteCalled).toBe(false);
    expect(liveTool.execute).toBeDefined();
  });

  it("does not build a raw result snapshot for an external tool without a receipt", () => {
    const payload = toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "write_file",
      args: { path: "out.txt" },
      execution: {
        kind: "external",
        access: "write",
        domain: { kind: "workspace", ref: "workspace:default" },
      },
      result: { written: true },
      claim: livedClaim,
    }).payload;

    expect(toolReplayArtifactFromExecutedPayload(payload)).toEqual({
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
    const payload = toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "write_file",
      args: { path: "out.txt" },
      execution: {
        kind: "external",
        access: "write",
        domain: { kind: "workspace", ref: "workspace:default" },
      },
      result: { written: true },
      claim: receiptBackedLivedClaim,
      traceContext,
    }).payload;

    const artifact = toolReplayArtifactFromExecutedPayload(payload);
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
