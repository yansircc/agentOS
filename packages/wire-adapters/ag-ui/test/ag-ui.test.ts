import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { safeLedgerEvent } from "@agent-os/kernel";
import { defineTool, deterministicToolExecution } from "@agent-os/kernel/tools";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  chatIngestedEvent,
  llmRequestedEvent,
  llmResponseEvent,
  runtimeCompletedAfterToolsEvent,
  toolExecutedEvent,
  toolRejectedEvent,
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";
import { settleToolExecuted, settleToolPolicyRejected } from "@agent-os/runtime";
import {
  AG_UI_WIRE_COMPATIBILITY,
  AgUiRunAgentInputSchema,
  agUiRunAgentInputToSubmitSpec,
  decodeAgUiRunAgentInput,
  decodeLedgerEventToAgUiEnvelope,
  encodeAgUiLedgerEventEnvelopeSse,
  framesForAgUiLedgerEnvelope,
  projectAgUiFramesToActivities,
  projectAgUiFrames,
  projectLedgerEventToAgUiEnvelope,
  projectLedgerEventsToAgUiFrames,
  projectLedgerSseToAgUiEnvelopes,
  projectLedgerSseToAgUiSse,
  projectToolToAgUiTool,
  verifyAgUiFrameSafety,
  type AgUiFrame,
  type AgUiRunAgentInput,
  type AgUiSafeValue,
} from "../src/index";

const scope = "ag-ui-test";

const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const commit = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const toolClaim = makePreClaim({
  operationRef: "tool:ag-ui-test:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "tool" },
  originRef: { originId: "run:1", originKind: "submit" },
});

const transcript = (): ReadonlyArray<LedgerEvent> => [
  commit(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "find weather" })),
  commit(
    2,
    chatIngestedEvent({
      ...runtimeIdentity,
      runId: 1,
      intent: "find weather",
      context: { hidden: "not projected" },
    }),
  ),
  commit(
    3,
    llmResponseEvent({
      ...runtimeIdentity,
      turn: { id: 1, index: 0 },
      items: [
        { type: "message", text: "Checking." },
        {
          type: "reasoning",
          summaryRef: "reasoning-summary-ref",
          metadata: { providerUrl: "https://provider.invalid/secret" },
        },
        {
          type: "tool_call",
          call: {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"city":"SF"}' },
            metadata: { credential: "secret-token" },
          },
        },
      ],
      usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
    }),
  ),
  commit(
    4,
    toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "lookup",
      args: '{"city":"SF"}',
      execution: deterministicToolExecution(),
      result: { temperature: 71 },
      claim: settleToolExecuted(
        toolClaim,
        defineTool({
          name: "lookup",
          description: "Lookup weather",
          args: Schema.Struct({ city: Schema.String }),
          authority: "tool",
          execution: deterministicToolExecution(),
          admit: () => Effect.succeed({ ok: true }),
          execute: () => Effect.succeed({ temperature: 71 }),
        }).contract,
      ),
    }),
  ),
  commit(
    5,
    agentRunCompletedEvent({
      ...runtimeIdentity,
      runId: 1,
      final: "Done.",
      output: "Done.",
      outputKind: "text",
      tokensUsed: 18,
    }),
  ),
];

const collectAsync = async <A>(source: AsyncIterable<A>): Promise<ReadonlyArray<A>> => {
  const values: A[] = [];
  for await (const value of source) values.push(value);
  return values;
};

async function* chunksOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

const summary = (
  reason: "tool_arguments" | "tool_result" | "run_output" | "run_input",
  extra: Readonly<Record<string, AgUiSafeValue>>,
): AgUiSafeValue => ({ redacted: true, reason, ...extra });

const summaryText = (
  reason: "tool_arguments" | "tool_result" | "run_output" | "run_input",
  extra: Readonly<Record<string, AgUiSafeValue>>,
): string => JSON.stringify(summary(reason, extra));

describe("@agent-os/ag-ui", () => {
  it("records the pinned AG-UI wire compatibility contract", () => {
    expect(AG_UI_WIRE_COMPATIBILITY).toEqual({
      core: "@ag-ui/core@0.0.55",
      client: "@ag-ui/client@0.0.55",
    });
  });

  it("owns the AG-UI run input schema for unknown boundaries", () => {
    const input = decodeAgUiRunAgentInput({
      threadId: "thread-1",
      runId: "client-run-1",
      messages: [{ id: "m1", role: "user", content: "ship" }],
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      forwardedProps: { safe: true },
    });
    expect(input.messages.at(0)?.content).toBe("ship");

    const standard = Schema.standardSchemaV1(AgUiRunAgentInputSchema);
    expect(standard["~standard"].validate(input)).toEqual({ value: input });
    expect(() =>
      decodeAgUiRunAgentInput({
        threadId: "thread-1",
        runId: "client-run-1",
        messages: [{ id: "m1", role: "customer", content: "invalid role" }],
      }),
    ).toThrow();
  });

  it("maps typed runtime events into AG-UI frames without raw payload parsing", () => {
    const frames = projectLedgerEventsToAgUiFrames(transcript(), { threadId: "thread-1" });
    expect(frames).toEqual<ReadonlyArray<AgUiFrame>>([
      {
        type: "RUN_STARTED",
        timestamp: 10,
        threadId: "thread-1",
        runId: "1",
      },
      {
        type: "CUSTOM",
        timestamp: 20,
        name: "agent-os.chat.ingested",
        value: { runId: 1, intent: summary("run_input", { type: "string", bytes: 12 }) },
      },
      {
        type: "TEXT_MESSAGE_START",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:message:0",
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:message:0",
        delta: "Checking.",
      },
      {
        type: "TEXT_MESSAGE_END",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:message:0",
      },
      {
        type: "REASONING_START",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:reasoning:0",
      },
      {
        type: "REASONING_MESSAGE_START",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:reasoning:0",
      },
      {
        type: "REASONING_MESSAGE_CONTENT",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:reasoning:0",
        delta: "reasoning-summary-ref",
      },
      {
        type: "REASONING_MESSAGE_END",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:reasoning:0",
      },
      {
        type: "REASONING_END",
        timestamp: 30,
        messageId: "agent-os:run:1:turn:0:reasoning:0",
      },
      {
        type: "CUSTOM",
        timestamp: 30,
        name: "agent-os.tool.started",
        value: {
          runId: "1",
          turnIndex: 0,
          toolCallId: "call-1",
          toolName: "lookup",
        },
      },
      {
        type: "TOOL_CALL_START",
        timestamp: 30,
        toolCallId: "call-1",
        toolCallName: "lookup",
      },
      {
        type: "TOOL_CALL_ARGS",
        timestamp: 30,
        toolCallId: "call-1",
        delta: summaryText("tool_arguments", { type: "string", bytes: 13 }),
      },
      {
        type: "TOOL_CALL_END",
        timestamp: 30,
        toolCallId: "call-1",
      },
      {
        type: "CUSTOM",
        timestamp: 30,
        name: "agent-os.llm.completed",
        value: {
          runId: 1,
          turnIndex: 0,
          usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
        },
      },
      {
        type: "CUSTOM",
        timestamp: 30,
        name: "agent-os.llm.usage",
        value: {
          runId: 1,
          turnIndex: 0,
          usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
        },
      },
      {
        type: "TOOL_CALL_RESULT",
        timestamp: 40,
        messageId: "agent-os:run:1:tool-result:call-1",
        toolCallId: "call-1",
        content: summaryText("tool_result", { type: "object", keys: ["temperature"] }),
        role: "tool",
      },
      {
        type: "CUSTOM",
        timestamp: 40,
        name: "agent-os.tool.completed",
        value: {
          runId: "1",
          toolCallId: "call-1",
          toolName: "lookup",
        },
      },
      {
        type: "RUN_FINISHED",
        timestamp: 50,
        threadId: "thread-1",
        runId: "1",
        result: {
          final: summary("run_output", { type: "string", bytes: 5 }),
          output: summary("run_output", { type: "string", bytes: 5 }),
          outputKind: "text",
          tokensUsed: 18,
        },
        outcome: { type: "success" },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("provider.invalid");
    expect(JSON.stringify(frames)).not.toContain("secret-token");
    expect(JSON.stringify(frames)).not.toContain('"city":"SF"');
    expect(JSON.stringify(frames)).not.toContain('"temperature":71');
    expect(projectAgUiFrames(frames)).toEqual({
      runId: "1",
      threadId: "thread-1",
      status: "completed",
      text: "Checking.",
      textMessages: [
        {
          messageId: "agent-os:run:1:turn:0:message:0",
          role: "assistant",
          text: "Checking.",
        },
      ],
      toolCalls: [
        {
          toolCallId: "call-1",
          name: "lookup",
          args: summaryText("tool_arguments", { type: "string", bytes: 13 }),
          result: summaryText("tool_result", { type: "object", keys: ["temperature"] }),
        },
      ],
      custom: [
        {
          type: "CUSTOM",
          timestamp: 20,
          name: "agent-os.chat.ingested",
          value: { runId: 1, intent: summary("run_input", { type: "string", bytes: 12 }) },
        },
        {
          type: "CUSTOM",
          timestamp: 30,
          name: "agent-os.tool.started",
          value: {
            runId: "1",
            turnIndex: 0,
            toolCallId: "call-1",
            toolName: "lookup",
          },
        },
        {
          type: "CUSTOM",
          timestamp: 30,
          name: "agent-os.llm.completed",
          value: {
            runId: 1,
            turnIndex: 0,
            usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
          },
        },
        {
          type: "CUSTOM",
          timestamp: 30,
          name: "agent-os.llm.usage",
          value: {
            runId: 1,
            turnIndex: 0,
            usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18 },
          },
        },
        {
          type: "CUSTOM",
          timestamp: 40,
          name: "agent-os.tool.completed",
          value: {
            runId: "1",
            toolCallId: "call-1",
            toolName: "lookup",
          },
        },
      ],
    });
  });

  it("projects runtime LLM request and complete-after-tools facts as safe custom frames", () => {
    const frames = projectLedgerEventsToAgUiFrames(
      [
        commit(
          1,
          llmRequestedEvent({
            ...runtimeIdentity,
            runId: 1,
            turn: { id: 1, index: 0 },
            modelId: "claude-sonnet-4-6",
            toolNames: ["read_file", "write_editor_patch_candidate"],
            toolChoice: "required",
          }),
        ),
        commit(
          2,
          runtimeCompletedAfterToolsEvent({
            ...runtimeIdentity,
            runId: 1,
            turn: { id: 1, index: 0 },
            toolNames: ["write_editor_patch_candidate"],
            tokensUsed: 42,
          }),
        ),
      ],
      { threadId: "thread-1" },
    );

    expect(frames).toEqual([
      {
        type: "CUSTOM",
        timestamp: 10,
        name: "agent-os.llm.requested",
        value: {
          runId: 1,
          turnIndex: 0,
          modelId: "claude-sonnet-4-6",
          toolNames: ["read_file", "write_editor_patch_candidate"],
          toolChoice: "required",
        },
      },
      {
        type: "CUSTOM",
        timestamp: 20,
        name: "agent-os.runtime.completed_after_tools",
        value: {
          runId: 1,
          turnIndex: 0,
          toolNames: ["write_editor_patch_candidate"],
          tokensUsed: 42,
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("prompt");
    expect(JSON.stringify(frames)).not.toContain("arguments");
  });

  it("projects safe tool start and completion facts with file io summaries", () => {
    const frames = projectLedgerEventsToAgUiFrames(
      [
        commit(
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
        ),
        commit(
          2,
          toolExecutedEvent({
            ...runtimeIdentity,
            runId: 1,
            toolCallId: "call-write",
            name: "write_editor_patch_candidate",
            args: '{"content":"SECRET_CODE"}',
            execution: deterministicToolExecution(),
            result: { path: "/output/code.fragment", bytesWritten: 42 },
            claim: settleToolExecuted(
              toolClaim,
              defineTool({
                name: "write_editor_patch_candidate",
                description: "write fixed candidate",
                args: Schema.Struct({ content: Schema.String }),
                authority: "tool",
                execution: deterministicToolExecution(),
                admit: () => Effect.succeed({ ok: true }),
                execute: () => Effect.succeed({ path: "/output/code.fragment", bytesWritten: 42 }),
              }).contract,
            ),
          }),
        ),
      ],
      { threadId: "thread-1" },
    );

    expect(frames).toEqual(
      expect.arrayContaining([
        {
          type: "CUSTOM",
          timestamp: 10,
          name: "agent-os.tool.started",
          value: {
            runId: "1",
            turnIndex: 0,
            toolCallId: "call-read",
            toolName: "read_file",
            io: [{ action: "read", path: "/input/request.json" }],
          },
        },
        {
          type: "CUSTOM",
          timestamp: 20,
          name: "agent-os.tool.completed",
          value: {
            runId: "1",
            toolCallId: "call-write",
            toolName: "write_editor_patch_candidate",
            io: [{ action: "write", path: "/output/code.fragment", bytes: 42 }],
          },
        },
      ]),
    );
    expect(JSON.stringify(frames)).not.toContain("SECRET_CODE");
  });

  it("projects a decoded ledger row into an AG-UI envelope without raw ledger metadata", () => {
    const event = transcript()[2]!;
    const envelope = projectLedgerEventToAgUiEnvelope(event);
    expect(envelope).toMatchObject({
      id: 3,
      ts: 30,
      kind: "llm.response",
      scopeKey: "conversation:ag-ui-test",
    });
    expect(envelope).not.toHaveProperty("scopeRef");
    expect(envelope).not.toHaveProperty("factOwnerRef");
    expect(envelope).not.toHaveProperty("effectAuthorityRef");
    expect(envelope.agUiFrames).toContainEqual({
      type: "TOOL_CALL_ARGS",
      timestamp: 30,
      toolCallId: "call-1",
      delta: summaryText("tool_arguments", { type: "string", bytes: 13 }),
    });
    expect(framesForAgUiLedgerEnvelope(envelope).at(0)).toMatchObject({
      eventId: 3,
      eventTs: 30,
      eventKind: "llm.response",
      eventScopeKey: "conversation:ag-ui-test",
    });
    expect(framesForAgUiLedgerEnvelope(envelope).at(0)).not.toHaveProperty("eventScopeRef");

    const decoded = decodeLedgerEventToAgUiEnvelope({
      id: event.id,
      ts: event.ts,
      kind: event.kind,
      scopeRef: event.scopeRef,
      factOwnerRef: event.factOwnerRef,
      effectAuthorityRef: event.effectAuthorityRef,
      payload: event.payload,
    });
    expect(decoded.agUiFrames.length).toBeGreaterThan(0);
    expect(JSON.stringify(decoded)).not.toContain("secret-token");
    expect(() => decodeLedgerEventToAgUiEnvelope({ id: "3", payload: {} })).toThrow();
  });

  it("projects ledger SSE into AG-UI envelopes and AG-UI SSE chunks", async () => {
    const ledgerEvent = transcript()[0]!;
    const ledgerSse = [
      "event: heartbeat",
      "data: {}",
      "",
      "event: ledger",
      `data: ${JSON.stringify(ledgerEvent)}`,
      "",
      "",
    ].join("\n");
    const envelopes = await collectAsync(projectLedgerSseToAgUiEnvelopes(chunksOf(ledgerSse)));
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ id: 1, kind: "agent.run.started" });

    const chunks = await collectAsync(projectLedgerSseToAgUiSse(chunksOf(ledgerSse)));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(encodeAgUiLedgerEventEnvelopeSse(envelopes[0]!));
    expect(chunks[0]).toContain("event: ag_ui");
  });

  it("projects AG-UI frames into neutral activities without web-cursor run semantics", () => {
    const activities = projectAgUiFramesToActivities(
      projectLedgerEventsToAgUiFrames(transcript(), { threadId: "thread-1" }),
    );
    expect(activities).toEqual(
      expect.arrayContaining([
        {
          kind: "message",
          id: "agent-os:run:1:turn:0:message:0",
          role: "assistant",
          text: "Checking.",
          startedAt: 30,
          updatedAt: 30,
          endedAt: 30,
        },
        {
          kind: "tool_call",
          id: "call-1",
          toolCallId: "call-1",
          name: "lookup",
          args: summaryText("tool_arguments", { type: "string", bytes: 13 }),
          result: summaryText("tool_result", { type: "object", keys: ["temperature"] }),
          status: "completed",
          startedAt: 30,
          updatedAt: 40,
          completedAt: 40,
        },
      ]),
    );
    expect(activities.some((activity) => activity.kind === "reasoning")).toBe(true);
    expect(activities.some((activity) => activity.kind === "custom")).toBe(true);
  });

  it("maps aborts to AG-UI run errors with the run id retained", () => {
    const frames = projectLedgerEventsToAgUiFrames([
      commit(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "too much" })),
      commit(
        2,
        agentRunAbortedEvent({
          ...runtimeIdentity,
          kind: "agent.aborted.budget_tokens",
          runId: 1,
          tokensUsed: 20,
          payload: { tokensMax: 10 },
        }),
      ),
    ]);
    expect(frames.at(-1)).toEqual({
      type: "RUN_ERROR",
      timestamp: 20,
      threadId: "conversation:ag-ui-test",
      runId: "1",
      message: "agent.aborted.budget_tokens",
      code: "agent.aborted.budget_tokens",
    });
  });

  it("maps recoverable runtime policy tool rejections to custom frames", () => {
    const frames = projectLedgerEventsToAgUiFrames([
      commit(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "write files" })),
      commit(
        2,
        toolRejectedEvent({
          ...runtimeIdentity,
          runId: 1,
          toolCallId: "call-duplicate",
          name: "write_html",
          args: { type: "string", bytes: 2, truncated: false },
          execution: deterministicToolExecution(),
          claim: settleToolPolicyRejected(toolClaim, "policy_tool_already_executed"),
          diagnostics: {
            phase: "policy",
            reason: "policy_tool_already_executed",
          },
        }),
      ),
    ]);

    expect(frames.at(-1)).toMatchObject({
      type: "CUSTOM",
      name: "agent-os.tool.policy_rejected",
      value: {
        toolName: "write_html",
        diagnostics: {
          phase: "policy",
          reason: "policy_tool_already_executed",
        },
      },
    });
    expect(projectAgUiFrames(frames).status).toBe("running");
  });

  it("fails malformed runtime payloads before AG-UI mapping", () => {
    expect(() =>
      projectLedgerEventsToAgUiFrames([
        {
          id: 1,
          ts: 1,
          ...eventIdentity(scope),
          kind: "tool.executed",
          payload: { runId: 1, name: "lookup" },
        },
      ]),
    ).toThrow();
  });

  it("projects product events only through explicit owner safe event projectors", () => {
    const frames = projectLedgerEventsToAgUiFrames(
      [
        {
          id: 1,
          ts: 1,
          ...eventIdentity(scope),
          kind: "workspace.file.observed",
          payload: {
            path: "README.md",
            content: "not exposed",
            stats: { bytes: 12, secret: "nested secret" },
          },
        },
      ],
      {
        safeEventProjectors: [
          (event) =>
            event.kind === "workspace.file.observed"
              ? safeLedgerEvent(event, { path: "README.md", bytes: 12 })
              : undefined,
        ],
      },
    );
    expect(frames).toEqual([
      {
        type: "CUSTOM",
        timestamp: 1,
        name: "workspace.file.observed",
        value: {
          id: 1,
          kind: "workspace.file.observed",
          safePayload: { path: "README.md", bytes: 12 },
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("not exposed");
    expect(JSON.stringify(frames)).not.toContain("nested secret");
  });

  it("verifies fixture-owned forbidden literals as regression evidence only", () => {
    const frames = projectLedgerEventsToAgUiFrames(transcript(), { threadId: "thread-1" });
    expect(
      verifyAgUiFrameSafety(frames, {
        forbiddenLiterals: ["secret-token", '"city":"SF"', '"temperature":71'],
        forbiddenPatterns: [/provider\.invalid/u],
      }),
    ).toEqual([]);
    expect(
      verifyAgUiFrameSafety(
        [
          {
            type: "TOOL_CALL_RESULT",
            messageId: "result-1",
            toolCallId: "call-1",
            content: "secret-token",
          },
        ],
        { forbiddenLiterals: ["secret-token"] },
      ),
    ).toEqual([
      {
        kind: "literal",
        frameIndex: 0,
        path: "$.content",
        match: "secret-token",
      },
    ]);
  });

  it("maps AG-UI RunAgentInput into submit without accepting AG-UI tools as source truth", () => {
    const input: AgUiRunAgentInput = {
      threadId: "thread-1",
      runId: "client-run-1",
      state: { ui: "local" },
      messages: [
        { id: "m1", role: "system", content: "ignored for intent" },
        { id: "m2", role: "user", content: "ship it" },
      ],
      context: [{ description: "selection", value: "file.ts" }],
      tools: [{ name: "client-tool", description: "not source", parameters: { type: "object" } }],
      forwardedProps: { allowed: 1, secret: "drop" },
    };
    const submit = agUiRunAgentInputToSubmitSpec(input, {
      route: {
        kind: "openai-chat-compatible",
        endpointRef: "endpoint:openai",
        credentialRef: "credential:openai",
        modelId: "model",
      },
      tools: {},
      effectAuthorityRef: { authorityClass: "llm_route", authorityId: "ag-ui-test" },
      forwardedPropAllowlist: ["allowed"],
    });
    expect(submit.intent).toBe("ship it");
    expect(submit.tools).toEqual({});
    expect(submit.context.agUi).toEqual({
      threadId: "thread-1",
      clientRunId: "client-run-1",
      parentRunId: undefined,
      messages: input.messages,
      context: input.context,
      state: input.state,
      clientToolNames: ["client-tool"],
      forwardedProps: { allowed: 1 },
    });
    expect(JSON.stringify(submit)).not.toContain("drop");
    expect("resolvedMaterials" in submit).toBe(false);
  });

  it("rejects AG-UI resume input because it is not a runtime SubmitSpec.resume decision", () => {
    expect(() =>
      agUiRunAgentInputToSubmitSpec(
        {
          threadId: "thread-1",
          runId: "client-run-1",
          messages: [],
          resume: [{ interruptId: "i1", status: "resolved", payload: { approved: true } }],
        },
        {
          route: {
            kind: "openai-chat-compatible",
            endpointRef: "endpoint:openai",
            credentialRef: "credential:openai",
            modelId: "model",
          },
          tools: {},
          effectAuthorityRef: { authorityClass: "llm_route", authorityId: "ag-ui-test" },
        },
      ),
    ).toThrow("AG-UI resume input cannot be lowered to SubmitSpec.resume");
  });

  it("passes through runtime resume decisions supplied by defaults", () => {
    const submit = agUiRunAgentInputToSubmitSpec(
      {
        threadId: "thread-1",
        runId: "client-run-1",
        messages: [],
      },
      {
        route: {
          kind: "openai-chat-compatible",
          endpointRef: "endpoint:openai",
          credentialRef: "credential:openai",
          modelId: "model",
        },
        tools: {},
        effectAuthorityRef: { authorityClass: "llm_route", authorityId: "ag-ui-test" },
        resume: {
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "i1",
          gateRef: "decision-gate:i1",
          decisionRef: "decision:i1",
          resume: { approved: true },
        },
      },
    );

    expect(submit.resume).toEqual({
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "i1",
      gateRef: "decision-gate:i1",
      decisionRef: "decision:i1",
      resume: { approved: true },
    });
    expect(submit.context.agUi).toEqual({
      threadId: "thread-1",
      clientRunId: "client-run-1",
      parentRunId: undefined,
      messages: [],
      context: [],
      state: undefined,
      clientToolNames: [],
      forwardedProps: {},
    });
  });

  it("projects runtime interrupt and resume facts as AG-UI timeline frames", () => {
    const frames = projectLedgerEventsToAgUiFrames([
      commit(1, agentRunStartedEvent({ ...runtimeIdentity, intent: "approve" })),
      commit(
        2,
        agentRunInterruptedEvent({
          ...runtimeIdentity,
          runId: 1,
          turn: { id: 1, index: 0 },
          interruptId: "approval-1",
          reason: "decision_required",
          resumeSchema: { type: "object", required: ["approved"] },
          tokensUsed: 5,
        }),
      ),
      commit(
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
    ]);

    expect(frames).toEqual([
      {
        type: "RUN_STARTED",
        timestamp: 10,
        threadId: "conversation:ag-ui-test",
        runId: "1",
      },
      {
        type: "CUSTOM",
        timestamp: 20,
        name: "agent-os.run.interrupted",
        value: {
          runId: 1,
          turnIndex: 0,
          interruptId: "approval-1",
          reason: "decision_required",
          hasResumeSchema: true,
          tokensUsed: 5,
        },
      },
      {
        type: "CUSTOM",
        timestamp: 30,
        name: "agent-os.run.resumed",
        value: {
          runId: 1,
          turnIndex: 0,
          interruptId: "approval-1",
          resumedAtEventId: 2,
        },
      },
    ]);
    expect(projectAgUiFrames(frames)).toMatchObject({
      runId: "1",
      threadId: "conversation:ag-ui-test",
      status: "running",
    });
  });

  it("projects agentOS Tool schemas to AG-UI tool parameters", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup weather",
      args: Schema.Struct({ city: Schema.String }),
      authority: "tool",
      execution: deterministicToolExecution(),
      admit: () => Effect.succeed({ ok: true }),
      execute: () => Effect.succeed({ temperature: 71 }),
    });
    expect(projectToolToAgUiTool(tool)).toEqual({
      name: "lookup",
      description: "Lookup weather",
      parameters: tool.argsSchema.projections.canonical,
    });
  });
});
