import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim, RejectedClaim } from "@agent-os/kernel/effect-claim";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  decodeRuntimeLedgerEvent,
  llmResponseEvent,
  RUNTIME_ABORT_EVENT_KINDS,
  toolExecutedEvent,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "../src/runtime-events";

const scope = "runtime-event-test";
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
  authorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  anchorRef: {
    anchorId: "tool.executed:tool:runtime-event-test:1:0:call-1",
    anchorKind: "carrier_proof",
    carrierRef: "tool:lookup",
  },
};

const rejectedClaim: RejectedClaim = {
  phase: "rejected",
  operationRef: "tool:runtime-event-test:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  authorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
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
  ...eventIdentity(spec.scope),
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
      agentRunStartedEvent({ scope, intent: "answer", traceContext }),
      chatIngestedEvent({
        scope,
        runId: 1,
        intent: "answer",
        context: { topic: "runtime" },
        traceContext,
      }),
      llmResponseEvent({
        scope,
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
        scope,
        runId: 1,
        toolCallId: "call-1",
        name: "lookup",
        args: '{"q":"x"}',
        execution: { kind: "pure" },
        result: { ok: true },
        claim: livedClaim,
        traceContext,
      }),
      toolRejectedEvent({
        scope,
        runId: 1,
        toolCallId: "call-1",
        name: "lookup",
        args: '{"q":"x"}',
        execution: { kind: "pure" },
        claim: rejectedClaim,
        traceContext,
      }),
      agentRunCompletedEvent({ scope, runId: 1, event: "answer.ready", traceContext }),
      ...RUNTIME_ABORT_EVENT_KINDS.map((kind) =>
        agentRunAbortedEvent({
          scope,
          kind,
          runId: 1,
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
      decodeRuntimeLedgerEvent(rawEvent(5, "agent.run.completed", { event: "answer.ready" })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(rawEvent(6, "agent.aborted.tool_error", { reason: "tool_error" })),
    ).toThrow();
    expect(() =>
      decodeRuntimeLedgerEvent(
        rawEvent(7, "agent.run.started", {
          intent: "answer",
          traceContext: { traceparent: "00-test" },
        }),
      ),
    ).toThrow();
  });
});
