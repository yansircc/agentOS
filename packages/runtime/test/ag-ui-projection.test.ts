import { describe, expect, it } from "@effect/vitest";
import type { LivedClaim, RejectedClaim } from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";
import { decodeRecordedLedgerEvent } from "@agent-os/core/types";
import {
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  llmRequestedEvent,
  llmResponseEvent,
  RUNTIME_FACT_OWNER,
  runtimeCompletedAfterToolsEvent,
  toolExecutedEvent,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/core/runtime-protocol";
import {
  encodeAgUiLedgerEventEnvelopeSse,
  projectLedgerEventsToAgUiFrames,
  projectLedgerEventToAgUiEnvelope,
  projectSafeLedgerEventToAgUiFrames,
  type AgUiCustomFrame,
  type AgUiFrame,
  type AgUiRecordedLedgerEvent,
} from "../src/ag-ui";

const scope = "ag-ui-projection-test";
const identity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const livedClaim: LivedClaim = {
  phase: "lived",
  operationRef: "tool:ag-ui-projection-test:1:0:call-1",
  scopeRef: identity.scopeRef,
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  anchorRef: {
    anchorId: "tool.executed:tool:ag-ui-projection-test:1:0:call-1",
    anchorKind: "carrier_proof",
    carrierRef: "tool:lookup",
  },
};

const rejectedClaim: RejectedClaim = {
  phase: "rejected",
  operationRef: "tool:ag-ui-projection-test:1:0:call-2",
  scopeRef: identity.scopeRef,
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  rejectionRef: {
    rejectionId: "tool.rejected:tool:ag-ui-projection-test:1:0:call-2",
    rejectionKind: "policy_denied",
    reason: "denied",
  },
};

const runtimeEvent = (
  id: number,
  spec: RuntimeEventCommitSpec,
  factOwnerRef: string = RUNTIME_FACT_OWNER,
): AgUiRecordedLedgerEvent =>
  decodeRecordedLedgerEvent({
    id,
    ts: id * 10,
    kind: spec.kind,
    scopeRef: spec.scopeRef,
    effectAuthorityRef: spec.effectAuthorityRef,
    factOwnerRef,
    payload: spec.payload,
  } satisfies LedgerEvent);

const customAgentOsFrames = (frames: ReadonlyArray<AgUiFrame>): ReadonlyArray<AgUiCustomFrame> =>
  frames.filter(
    (frame): frame is AgUiCustomFrame =>
      frame.type === "CUSTOM" && frame.name.startsWith("agent-os."),
  );

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

describe("AG-UI ledger projection", () => {
  it("surfaces the owner safe event and derives frames from the same projection", () => {
    const event = runtimeEvent(
      3,
      llmResponseEvent({
        ...identity,
        turn: { id: 1, index: 0 },
        items: [
          { type: "message", text: "hello" },
          {
            type: "tool_call",
            call: {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) },
            },
          },
        ],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      }),
    );

    const spec = { threadId: "thread-1" };
    const envelope = projectLedgerEventToAgUiEnvelope(event, spec);

    expect(envelope.safeEvent).toMatchObject({
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      scopeKey: `conversation:${scope}`,
      factOwnerRef: RUNTIME_FACT_OWNER,
    });
    expect(envelope.safeEvent).not.toBeNull();
    expect(envelope.agUiFrames).toEqual(
      projectSafeLedgerEventToAgUiFrames(envelope.safeEvent!, spec),
    );
    expect(envelope.agUiFrames).toEqual(projectLedgerEventsToAgUiFrames([event], spec));
    expect(envelope.agUiFrames.length).toBeGreaterThan(1);
  });

  it("keeps unprojected owners fail-closed in the envelope", () => {
    const event = runtimeEvent(
      1,
      chatIngestedEvent({ ...identity, runId: 1, intent: "answer", context: {} }),
      "@agent-os/test-unowned",
    );

    expect(projectLedgerEventToAgUiEnvelope(event)).toMatchObject({
      id: event.id,
      kind: "chat.ingested",
      safeEvent: null,
      agUiFrames: [],
    });
    expect(projectLedgerEventsToAgUiFrames([event])).toEqual([]);
  });

  it("encodes safeEvent as an additive SSE envelope field", () => {
    const event = runtimeEvent(1, agentRunStartedEvent({ ...identity, intent: "answer" }));
    const envelope = projectLedgerEventToAgUiEnvelope(event, { threadId: "thread-1" });
    const sse = encodeAgUiLedgerEventEnvelopeSse(envelope);
    const dataLine = sse.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();

    const encoded = JSON.parse(dataLine!.slice("data: ".length)) as unknown;
    expect(encoded).toMatchObject({
      id: 1,
      kind: "agent.run.started",
      safeEvent: {
        id: 1,
        kind: "agent.run.started",
        factOwnerRef: RUNTIME_FACT_OWNER,
      },
      agUiFrames: [{ type: "RUN_STARTED", runId: "1" }],
    });
  });

  it("keeps every agent-os CUSTOM payload runId numeric", () => {
    const events = [
      runtimeEvent(1, agentRunStartedEvent({ ...identity, intent: "answer" })),
      runtimeEvent(2, chatIngestedEvent({ ...identity, runId: 1, intent: "answer", context: {} })),
      runtimeEvent(
        3,
        agentRunInterruptedEvent({
          ...identity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "interrupt-1",
          reason: "tool_approval_required",
          resumeSchema: { type: "object" },
          tokensUsed: 2,
          decision: {
            gateRef: "gate-1",
            subjectRef: "subject-1",
            toolCallId: "call-2",
            toolName: "lookup",
          },
        }),
      ),
      runtimeEvent(
        4,
        agentRunResumedEvent({
          ...identity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "interrupt-1",
          resume: { kind: "approval", approved: true },
          resumedAtEventId: 3,
        }),
      ),
      runtimeEvent(
        5,
        llmRequestedEvent({
          ...identity,
          runId: 1,
          turn: { id: 1, index: 0 },
          modelId: "test-model",
          toolNames: ["lookup"],
          toolChoice: "required",
        }),
      ),
      runtimeEvent(
        6,
        llmResponseEvent({
          ...identity,
          turn: { id: 1, index: 0 },
          items: [
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) },
              },
            },
            { type: "refusal", reason: "no" },
            { type: "error", message: "upstream failed" },
          ],
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        }),
      ),
      runtimeEvent(
        7,
        runtimeCompletedAfterToolsEvent({
          ...identity,
          runId: 1,
          turn: { id: 1, index: 0 },
          toolNames: ["lookup"],
          tokensUsed: 3,
        }),
      ),
      runtimeEvent(
        8,
        toolExecutedEvent({
          ...identity,
          runId: 1,
          toolCallId: "call-1",
          name: "lookup",
          args: { q: "x" },
          execution: { kind: "deterministic" },
          result: { ok: true },
          claim: livedClaim,
        }),
      ),
      runtimeEvent(
        9,
        toolRejectedEvent({
          ...identity,
          runId: 1,
          toolCallId: "call-2",
          name: "lookup",
          args: { q: "blocked" },
          execution: { kind: "deterministic" },
          claim: rejectedClaim,
          diagnostics: { phase: "policy", reason: "denied" },
        }),
      ),
    ];

    const frames = projectLedgerEventsToAgUiFrames(events, { threadId: "thread-1" });
    const started = frames.find((frame) => frame.type === "RUN_STARTED");
    expect(started).toMatchObject({ type: "RUN_STARTED", runId: "1" });

    const agentFrames = customAgentOsFrames(frames);
    const actualNames = [...new Set(agentFrames.map((frame) => frame.name))].sort();
    expect(actualNames).toEqual(
      [
        "agent-os.chat.ingested",
        "agent-os.llm.completed",
        "agent-os.llm.error",
        "agent-os.llm.refusal",
        "agent-os.llm.requested",
        "agent-os.llm.usage",
        "agent-os.run.interrupted",
        "agent-os.run.resumed",
        "agent-os.runtime.completed_after_tools",
        "agent-os.tool.completed",
        "agent-os.tool.policy_rejected",
        "agent-os.tool.started",
      ].sort(),
    );

    for (const frame of agentFrames) {
      const value = recordValue(frame.value);
      if (value !== null && Object.hasOwn(value, "runId")) {
        expect(typeof value.runId, frame.name).toBe("number");
      }
    }
  });
});
