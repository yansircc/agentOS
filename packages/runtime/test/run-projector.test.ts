import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/core/types";
import type { LivedClaim } from "@agent-os/core/effect-claim";
import { ABORT } from "@agent-os/core/abort";
import {
  projectAgentSession,
  projectAgentSessions,
  projectAgentSessionTurnLinks,
  projectRunsPage,
  projectRunStatus,
  projectRunTrace,
  projectSubmitResult,
  projectWorkflowRun,
  projectWorkflowRunLinks,
  projectWorkflowRuns,
} from "../src/run-projector";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  agentSessionTurnSubmittedEvent,
  chatIngestedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  workflowRunSubmittedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/core/runtime-protocol";

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
      execution: { kind: "deterministic" },
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
    const rejectedRows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "approval" })),
      event(
        2,
        agentRunAbortedEvent({
          ...runtimeIdentity,
          kind: ABORT.DECISION_REJECTED,
          runId: 1,
          tokensUsed: 7,
          payload: { reason: "rejected", gateRef: "gate-1", terminalRef: "decision-1" },
        }),
      ),
    ];
    expect(projectRunStatus(rejectedRows, 1)).toEqual({
      kind: "aborted",
      at: 20,
      abortKind: "agent.aborted.rejected",
    });
    expect(projectSubmitResult(rejectedRows, 1)).toEqual({
      ok: false,
      status: "aborted",
      runId: 1,
      reason: "rejected",
      eventCount: 2,
      tokensUsed: 7,
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
          reason: "approval_required",
          resumeSchema: { type: "object", required: ["approved"] },
          tokensUsed: 4,
          decision: {
            gateRef: "gate:approval-1",
            subjectRef: "tool:lookup",
            toolCallId: "call-1",
            toolName: "lookup",
          },
        }),
      ),
    ];

    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "interrupted",
      at: 20,
      event: "agent.run.interrupted",
      interruptId: "approval-1",
      reason: "approval_required",
    });
    expect(projectRunTrace(rows, 1)).toMatchObject({
      runId: 1,
      interruptions: [
        {
          at: 20,
          event: "agent.run.interrupted",
          interruptId: "approval-1",
          turn: { id: 1, index: 0 },
          reason: "approval_required",
          resumeSchema: { type: "object", required: ["approved"] },
        },
      ],
    });
    expect(projectSubmitResult(rows, 1)).toMatchObject({
      ok: false,
      status: "interrupted",
      runId: 1,
      eventCount: 2,
      tokensUsed: 4,
      interruptId: "approval-1",
      turn: { id: 1, index: 0 },
      gateRef: "gate:approval-1",
      continuation: {
        kind: "agent.run.continuation",
        runId: 1,
        interruptionEventId: 2,
      },
      inputRequest: {
        kind: "approval",
        toolCallId: "call-1",
        toolName: "lookup",
      },
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
          resume: { kind: "approval", approved: true },
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
          resume: { kind: "approval", approved: true },
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

  it("projects product runtime links without fabricating terminal run truth", () => {
    const rows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "summarize" })),
      event(
        2,
        agentSessionTurnSubmittedEvent({
          ...runtimeIdentity,
          sessionRef: "session:s1",
          turnRef: "turn:s1:1",
          runtimeRunId: 1,
        }),
      ),
      event(3, agentRunStartedEvent({ ...runtimeIdentity, intent: "summarize" })),
      event(
        4,
        workflowRunSubmittedEvent({
          ...runtimeIdentity,
          workflowId: "summarize",
          workflowRunId: "workflow-run:1",
          runtimeRunId: 3,
          idempotencyKey: "idem:1",
          inputDigest: "sha256:input",
        }),
      ),
    ];

    expect(projectAgentSessionTurnLinks(rows, "session:s1")).toEqual({
      sessionRef: "session:s1",
      turns: [
        {
          sessionRef: "session:s1",
          turnRef: "turn:s1:1",
          runtimeRunId: 1,
          eventId: 2,
          submittedAt: 20,
        },
      ],
    });
    expect(projectWorkflowRunLinks(rows, "summarize")).toEqual({
      workflowId: "summarize",
      runs: [
        {
          workflowId: "summarize",
          workflowRunId: "workflow-run:1",
          runtimeRunId: 3,
          eventId: 4,
          submittedAt: 40,
          idempotencyKey: "idem:1",
          inputDigest: "sha256:input",
        },
      ],
    });
    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "open_without_terminal",
      startedAt: 10,
    });
    expect(projectSubmitResult(rows, 1)).toBe(null);
  });

  it("lists product projections through the runtime projector owner", () => {
    const rows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "session one" })),
      event(
        2,
        agentSessionTurnSubmittedEvent({
          ...runtimeIdentity,
          sessionRef: "session:s1",
          turnRef: "turn:s1:1",
          runtimeRunId: 1,
        }),
      ),
      event(3, agentRunStartedEvent({ ...runtimeIdentity, intent: "workflow one" })),
      event(
        4,
        workflowRunSubmittedEvent({
          ...runtimeIdentity,
          workflowId: "summarize",
          workflowRunId: "workflow-run:1",
          runtimeRunId: 3,
        }),
      ),
      event(
        5,
        agentRunCompletedEvent({
          ...runtimeIdentity,
          runId: 3,
          final: "done",
          output: "done",
          outputKind: "text",
          tokensUsed: 0,
        }),
      ),
    ];

    expect(projectAgentSessions(rows)).toMatchObject({
      sessions: [
        {
          sessionRef: "session:s1",
          status: "running",
          activeRunId: 1,
          turns: [{ turnRef: "turn:s1:1", runtimeRunId: 1 }],
        },
      ],
    });
    expect(projectWorkflowRuns(rows, "summarize")).toMatchObject({
      workflowId: "summarize",
      runs: [
        {
          workflowRunId: "workflow-run:1",
          runtimeRunId: 3,
          status: "succeeded",
          output: "done",
          outputKind: "text",
        },
      ],
    });
  });

  it("projects workflow run lifecycle from product links and runtime terminal facts", () => {
    const runningRows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "summarize one" })),
      event(
        2,
        workflowRunSubmittedEvent({
          ...runtimeIdentity,
          workflowId: "summarize",
          workflowRunId: "workflow-run:1",
          runtimeRunId: 1,
          idempotencyKey: "idem:1",
          inputDigest: "sha256:input-1",
        }),
      ),
      event(3, agentRunStartedEvent({ ...runtimeIdentity, intent: "summarize two" })),
      event(
        4,
        workflowRunSubmittedEvent({
          ...runtimeIdentity,
          workflowId: "summarize",
          workflowRunId: "workflow-run:2",
          runtimeRunId: 3,
          idempotencyKey: "idem:2",
          inputDigest: "sha256:input-2",
        }),
      ),
    ];

    expect(projectWorkflowRunLinks(runningRows, "summarize")).toMatchObject({
      workflowId: "summarize",
      runs: [
        { workflowRunId: "workflow-run:1", runtimeRunId: 1 },
        { workflowRunId: "workflow-run:2", runtimeRunId: 3 },
      ],
    });
    expect(projectWorkflowRun(runningRows, "summarize", "workflow-run:1")).toMatchObject({
      workflowId: "summarize",
      workflowRunId: "workflow-run:1",
      runtimeRunId: 1,
      eventId: 2,
      submittedAt: 20,
      status: "running",
      idempotencyKey: "idem:1",
      inputDigest: "sha256:input-1",
      attempts: [{ runtimeRunId: 1, status: { kind: "open_without_terminal" } }],
    });
    expect(projectWorkflowRun(runningRows, "summarize", "workflow-run:2")).toMatchObject({
      status: "running",
      runtimeRunId: 3,
      attempts: [{ runtimeRunId: 3, status: { kind: "open_without_terminal" } }],
    });

    const succeededRows = [
      ...runningRows.slice(0, 2),
      event(
        3,
        agentRunCompletedEvent({
          ...runtimeIdentity,
          runId: 1,
          final: "done",
          output: { summary: "done" },
          outputKind: "json",
          tokensUsed: 2,
        }),
      ),
    ];
    expect(projectWorkflowRun(succeededRows, "summarize", "workflow-run:1")).toMatchObject({
      status: "succeeded",
      output: { summary: "done" },
      outputKind: "json",
      attempts: [{ runtimeRunId: 1, status: { kind: "delivered" } }],
    });

    const failedRows = [
      ...runningRows.slice(0, 2),
      event(
        3,
        agentRunAbortedEvent({
          ...runtimeIdentity,
          kind: ABORT.TOOL_ERROR,
          runId: 1,
          tokensUsed: 1,
          payload: { reason: "tool_error" },
        }),
      ),
    ];
    expect(projectWorkflowRun(failedRows, "summarize", "workflow-run:1")).toMatchObject({
      status: "failed",
      error: {
        reason: "tool_error",
        abortKind: "agent.aborted.tool_error",
      },
      attempts: [{ runtimeRunId: 1, status: { kind: "aborted" } }],
    });

    const cancelledRows = [
      ...runningRows.slice(0, 2),
      event(
        3,
        agentRunAbortedEvent({
          ...runtimeIdentity,
          kind: ABORT.DECISION_CANCELLED,
          runId: 1,
          tokensUsed: 1,
          payload: { reason: "cancelled" },
        }),
      ),
    ];
    expect(projectWorkflowRun(cancelledRows, "summarize", "workflow-run:1")).toMatchObject({
      status: "cancelled",
      error: {
        reason: "cancelled",
        abortKind: "agent.aborted.cancelled",
      },
    });

    expect(projectWorkflowRun(runningRows, "summarize", "missing")).toBe(null);
  });

  it("projects agent session lifecycle from product links and runtime run facts", () => {
    expect(projectAgentSession([], "session:s1")).toEqual({
      sessionRef: "session:s1",
      status: "idle",
      turns: [],
    });

    const runningRows = [
      event(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "turn 1" })),
      event(
        2,
        agentSessionTurnSubmittedEvent({
          ...runtimeIdentity,
          sessionRef: "session:s1",
          turnRef: "turn:s1:1",
          runtimeRunId: 1,
        }),
      ),
    ];

    expect(projectAgentSession(runningRows, "session:s1")).toEqual({
      sessionRef: "session:s1",
      status: "running",
      activeRunId: 1,
      latestRunId: 1,
      turns: [
        {
          sessionRef: "session:s1",
          turnRef: "turn:s1:1",
          runtimeRunId: 1,
          eventId: 2,
          submittedAt: 20,
          status: { kind: "open_without_terminal", startedAt: 10 },
        },
      ],
    });

    const waitingRows = [
      ...runningRows,
      event(
        3,
        agentRunInterruptedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "approval-1",
          reason: "approval_required",
          resumeSchema: { type: "object", required: ["approved"] },
          tokensUsed: 4,
          decision: {
            gateRef: "gate:approval-1",
            subjectRef: "tool:lookup",
            toolCallId: "call-1",
            toolName: "lookup",
          },
        }),
      ),
    ];

    expect(projectAgentSession(waitingRows, "session:s1")).toMatchObject({
      sessionRef: "session:s1",
      status: "waiting_for_user",
      activeRunId: 1,
      latestRunId: 1,
      pendingInputRequest: {
        kind: "approval",
        subjectRef: "tool:lookup",
        toolCallId: "call-1",
        toolName: "lookup",
      },
      turns: [
        {
          runtimeRunId: 1,
          status: {
            kind: "interrupted",
            interruptId: "approval-1",
            reason: "approval_required",
          },
        },
      ],
    });

    const completedRows = [
      ...runningRows,
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

    expect(projectAgentSession(completedRows, "session:s1")).toMatchObject({
      sessionRef: "session:s1",
      status: "idle",
      latestRunId: 1,
      turns: [{ runtimeRunId: 1, status: { kind: "delivered" } }],
    });

    const failedRows = [
      ...runningRows,
      event(
        3,
        agentRunAbortedEvent({
          ...runtimeIdentity,
          kind: ABORT.TOOL_ERROR,
          runId: 1,
          tokensUsed: 1,
          payload: { reason: "tool_error" },
        }),
      ),
    ];

    expect(projectAgentSession(failedRows, "session:s1")).toMatchObject({
      sessionRef: "session:s1",
      status: "failed",
      latestRunId: 1,
      turns: [{ runtimeRunId: 1, status: { kind: "aborted" } }],
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
