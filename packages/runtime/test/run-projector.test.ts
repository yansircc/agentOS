import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim } from "@agent-os/kernel/effect-claim";
import { ABORT } from "../src/abort";
import { projectRunsPage, projectRunStatus, projectRunTrace } from "../src/run-projector";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  type RuntimeEventCommitSpec,
} from "../src/runtime-events";

const scope = "projection-scope";

const livedClaim: LivedClaim = {
  phase: "lived",
  operationRef: "tool:projection-scope:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  authorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
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
  scope: spec.scope,
  payload: spec.payload,
});

const rawEvent = (id: number, kind: string, payload: unknown, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind,
  scope,
  payload,
});

const validRunRows = (): ReadonlyArray<LedgerEvent> => [
  event(1, agentRunStartedEvent({ scope, intent: "x" })),
  event(2, chatIngestedEvent({ scope, runId: 1, intent: "x", context: {} })),
  event(
    3,
    llmResponseEvent({
      scope,
      turn: { id: 1, index: 0 },
      items: [{ type: "message", text: "use tool" }],
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    }),
  ),
  event(
    4,
    toolExecutedEvent({
      scope,
      runId: 1,
      toolCallId: "call-1",
      name: "lookup",
      args: "{}",
      execution: { kind: "pure" },
      result: { ok: true },
      claim: livedClaim,
    }),
  ),
  rawEvent(5, "answer.ready", {
    final: "done",
    turn: { id: 1, index: 1 },
  }),
  event(6, agentRunCompletedEvent({ scope, runId: 1, event: "answer.ready" })),
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
        event: "answer.ready",
        payload: { runId: 1, event: "answer.ready" },
      },
    });
    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "delivered",
      at: 60,
      event: "answer.ready",
    });
  });

  it("projects open, aborted, orphaned, and listed runs from the same decoded stream", () => {
    expect(
      projectRunStatus([event(1, agentRunStartedEvent({ scope, intent: "open" }))], 1),
    ).toEqual({
      kind: "open_without_terminal",
      startedAt: 10,
    });
    expect(
      projectRunStatus(
        [
          event(1, agentRunStartedEvent({ scope, intent: "abort" })),
          event(
            2,
            agentRunAbortedEvent({
              scope,
              kind: ABORT.TOOL_ERROR,
              runId: 1,
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
              scope,
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
          event(1, agentRunStartedEvent({ scope, intent: "old" })),
          event(2, agentRunCompletedEvent({ scope, runId: 1, event: "old.done" })),
          event(3, agentRunStartedEvent({ scope, intent: "new" })),
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
          status: { kind: "delivered", at: 20, event: "old.done" },
          durationMs: 10,
        },
      ],
      nextCursor: null,
    });
  });

  it("does not decode product deliver events as runtime facts", () => {
    const rows = [
      event(1, agentRunStartedEvent({ scope, intent: "x" })),
      rawEvent(2, "answer.ready", "product payload can be any shape"),
      event(3, agentRunCompletedEvent({ scope, runId: 1, event: "answer.ready" })),
    ];

    expect(projectRunStatus(rows, 1)).toEqual({
      kind: "delivered",
      at: 30,
      event: "answer.ready",
    });
  });

  it("fails closed on malformed runtime payloads", () => {
    expect(() =>
      projectRunTrace(
        [
          event(1, agentRunStartedEvent({ scope, intent: "x" })),
          rawEvent(2, "llm.response", { turn: { id: 1, index: 0 } }),
        ],
        1,
      ),
    ).toThrow();
    expect(() =>
      projectRunStatus(
        [
          event(1, agentRunStartedEvent({ scope, intent: "x" })),
          rawEvent(2, "agent.run.completed", { event: "answer.ready" }),
        ],
        1,
      ),
    ).toThrow();
  });
});
