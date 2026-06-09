import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim } from "@agent-os/kernel/effect-claim";
import { ABORT } from "../src/abort";
import {
  projectRunsPage,
  projectRunStatus,
  projectRunTrace,
  projectSubmitResult,
} from "../src/run-projector";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  type RuntimeEventCommitSpec,
} from "../src/runtime-events";

const scope = "projection-scope";
const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};
const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const livedClaim: LivedClaim = {
  phase: "lived",
  operationRef: "tool:projection-scope:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  anchorRef: {
    anchorId: "tool.executed:tool:projection-scope:1:0:call-1",
    anchorKind: "carrier_proof",
    carrierRef: "tool:lookup",
  },
};

const event = (id: number, spec: RuntimeEventCommitSpec, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const rawEvent = (id: number, kind: string, payload: unknown, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind,
  ...eventIdentity(scope),
  payload,
});

const validRunRows = (): ReadonlyArray<LedgerEvent> => [
  event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "x" })),
  event(2, chatIngestedEvent({ ...runtimeIdentity, runId: 1, intent: "x", context: {} })),
  event(
    3,
    llmResponseEvent({
      ...runtimeIdentity,
      turn: { id: 1, index: 0 },
      items: [{ type: "message", text: "use tool" }],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    }),
  ),
  event(
    4,
    toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "lookup",
      args: "{}",
      execution: { kind: "pure" },
      result: { ok: true },
      claim: livedClaim,
    }),
  ),
  rawEvent(5, "answer.ready", { product: "event" }),
  event(
    6,
    agentRunCompletedEvent({
      ...runtimeIdentity,
      runId: 1,
      final: "done",
      output: "done",
      outputKind: "text",
      tokensUsed: 3,
      turn: { id: 1, index: 1 },
    }),
  ),
];

describe("runtime run projectors", () => {
  it("projects run trace and delivered status from decoded runtime facts", () => {
    const rows = validRunRows();

    expect(projectRunTrace(rows, 1)).toEqual({
      runId: 1,
      startedAt: 10,
      turns: [
        {
          index: 0,
          at: 30,
          text: "use tool",
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        },
      ],
      toolCalls: [
        {
          at: 40,
          name: "lookup",
          args: "{}",
          result: { ok: true },
        },
      ],
      terminal: {
        kind: "delivered",
        at: 60,
        event: "agent.run.completed",
        payload: {
          runId: 1,
          final: "done",
          output: "done",
          outputKind: "text",
          tokensUsed: 3,
          turn: { id: 1, index: 1 },
        },
      },
    });
    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "delivered",
      at: 60,
      event: "agent.run.completed",
    });
    expect(projectSubmitResult(rows, 1)).toEqual({
      ok: true,
      status: "delivered",
      runId: 1,
      final: "done",
      eventCount: 6,
      tokensUsed: 3,
    });
  });

  it("projects open, aborted, orphaned, and listed runs from the same decoded stream", () => {
    expect(
      projectRunStatus([event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "open" }))], 1),
    ).toEqual({
      kind: "open_without_terminal",
      startedAt: 10,
    });
    expect(
      projectRunStatus(
        [
          event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "abort" })),
          event(
            2,
            agentRunAbortedEvent({
              ...runtimeIdentity,
              kind: ABORT.TOOL_ERROR,
              runId: 1,
              tokensUsed: 0,
              payload: { reason: "tool_error" },
            }),
          ),
        ],
        1,
      ),
    ).toEqual({
      kind: "aborted",
      at: 20,
      abortKind: "agent.aborted.tool_error",
    });
    expect(
      projectRunStatus(
        [
          event(
            2,
            llmResponseEvent({
              ...runtimeIdentity,
              turn: { id: 99, index: 0 },
              items: [{ type: "message", text: "orphan" }],
              usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 },
            }),
          ),
        ],
        99,
      ),
    ).toEqual({
      kind: "orphaned",
      startedAt: 20,
      evidence: "llm.response",
    });

    expect(
      projectRunsPage(
        [
          event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "old" })),
          event(
            2,
            agentRunCompletedEvent({
              ...runtimeIdentity,
              runId: 1,
              final: "old",
              output: "old",
              outputKind: "text",
              tokensUsed: 1,
            }),
          ),
          event(3, agentRunStartedEvent({ ...runtimeIdentity, intent: "new" })),
        ],
        { limit: 2 },
      ),
    ).toEqual({
      runs: [
        {
          runId: 3,
          startedAt: 30,
          status: { kind: "open_without_terminal", startedAt: 30 },
        },
        {
          runId: 1,
          startedAt: 10,
          status: { kind: "delivered", at: 20, event: "agent.run.completed" },
          durationMs: 10,
        },
      ],
      nextCursor: null,
    });
  });

  it("projects interrupted and resumed lifecycle from ledger facts only", () => {
    const rows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "needs approval" })),
      event(
        2,
        agentRunInterruptedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "approval-1",
          reason: "decision_required",
          resumeSchema: { type: "object", required: ["approved"] },
          tokensUsed: 4,
        }),
      ),
    ];

    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "interrupted",
      at: 20,
      event: "agent.run.interrupted",
      interruptId: "approval-1",
      reason: "decision_required",
    });
    expect(projectRunTrace(rows, 1)).toMatchObject({
      runId: 1,
      interruptions: [
        {
          at: 20,
          event: "agent.run.interrupted",
          interruptId: "approval-1",
          turn: { id: 1, index: 0 },
          reason: "decision_required",
          resumeSchema: { type: "object", required: ["approved"] },
        },
      ],
    });

    const resumedRows = [
      ...rows,
      event(
        3,
        agentRunResumedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "approval-1",
          resume: { approved: true },
          resumedAtEventId: 2,
        }),
      ),
    ];

    expect(projectRunStatus(resumedRows, 1)).toEqual({
      kind: "open_without_terminal",
      startedAt: 10,
    });
    expect(projectRunTrace(resumedRows, 1)).toMatchObject({
      runId: 1,
      resumes: [
        {
          at: 30,
          event: "agent.run.resumed",
          interruptId: "approval-1",
          turn: { id: 1, index: 0 },
          resumedAtEventId: 2,
        },
      ],
    });
  });

  it("does not let unmatched resume facts fabricate a resumed run", () => {
    const rows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "needs approval" })),
      event(
        2,
        agentRunInterruptedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "approval-1",
          reason: "decision_required",
          resumeSchema: { type: "object" },
          tokensUsed: 4,
        }),
      ),
      event(
        3,
        agentRunResumedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "other",
          resume: { approved: true },
          resumedAtEventId: 2,
        }),
      ),
    ];

    expect(projectRunStatus(rows, 1)).toMatchObject({
      kind: "interrupted",
      interruptId: "approval-1",
    });
  });

  it("does not decode product deliver events as runtime facts", () => {
    const rows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "x" })),
      rawEvent(2, "answer.ready", "product payload can be any shape"),
      event(
        3,
        agentRunCompletedEvent({
          ...runtimeIdentity,
          runId: 1,
          final: "done",
          output: "done",
          outputKind: "text",
          tokensUsed: 1,
        }),
      ),
    ];

    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "delivered",
      at: 30,
      event: "agent.run.completed",
    });
  });

  it("does not fabricate SubmitResult without a terminal runtime fact", () => {
    expect(
      projectSubmitResult(
        [event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "open" }))],
        1,
      ),
    ).toBe(null);
  });

  it("fails closed on malformed runtime payloads", () => {
    expect(() =>
      projectRunTrace(
        [
          event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "x" })),
          rawEvent(2, "llm.response", { turn: { id: 1, index: 0 } }),
        ],
        1,
      ),
    ).toThrow();
    expect(() =>
      projectRunStatus(
        [
          event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "x" })),
          rawEvent(2, "agent.run.completed", { event: "answer.ready" }),
        ],
        1,
      ),
    ).toThrow();
  });
});
