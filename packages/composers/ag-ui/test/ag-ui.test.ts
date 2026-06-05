import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { defineTool, pureToolExecution } from "@agent-os/kernel/tools";
import { makePreClaim } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  chatIngestedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunStartedEvent,
} from "@agent-os/runtime/runtime-events";
import { settleToolExecuted } from "@agent-os/runtime";
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
  redactAgUiToolPayloadFrame,
  type AgUiActivity,
  type AgUiFrame,
  type AgUiRunAgentInput,
} from "../src/index";

const scope = "ag-ui-test";

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const commit = (
  id: number,
  spec: { kind: string; scope: string; payload: unknown },
): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  ...eventIdentity(spec.scope),
  payload: spec.payload,
});

const toolClaim = makePreClaim({
  operationRef: "tool:ag-ui-test:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  authorityRef: { authorityId: "tool:lookup", authorityClass: "tool" },
  originRef: { originId: "run:1", originKind: "submit" },
});

const transcript = (): ReadonlyArray<LedgerEvent> => [
  commit(1, agentRunStartedEvent({ scope, intent: "find weather" })),
  commit(
    2,
    chatIngestedEvent({
      scope,
      runId: 1,
      intent: "find weather",
      context: { hidden: "not projected" },
    }),
  ),
  commit(
    3,
    llmResponseEvent({
      scope,
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
      scope,
      runId: 1,
      toolCallId: "call-1",
      name: "lookup",
      args: '{"city":"SF"}',
      execution: pureToolExecution(),
      result: { temperature: 71 },
      claim: settleToolExecuted(
        toolClaim,
        defineTool({
          name: "lookup",
          description: "Lookup weather",
          args: Schema.Struct({ city: Schema.String }),
          authority: "tool",
          execution: pureToolExecution(),
          admit: () => ({ ok: true }),
          execute: () => ({ temperature: 71 }),
        }).contract,
      ),
    }),
  ),
  commit(5, agentRunCompletedEvent({ scope, runId: 1, event: "weather.delivered" })),
];

const collectAsync = async <A>(source: AsyncIterable<A>): Promise<ReadonlyArray<A>> => {
  const values: A[] = [];
  for await (const value of source) values.push(value);
  return values;
};

const streamOf = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

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
        value: { runId: 1, intent: "find weather" },
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
        type: "TOOL_CALL_START",
        timestamp: 30,
        toolCallId: "call-1",
        toolCallName: "lookup",
      },
      {
        type: "TOOL_CALL_ARGS",
        timestamp: 30,
        toolCallId: "call-1",
        delta: '{"city":"SF"}',
      },
      {
        type: "TOOL_CALL_END",
        timestamp: 30,
        toolCallId: "call-1",
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
        content: '{"temperature":71}',
        role: "tool",
      },
      {
        type: "RUN_FINISHED",
        timestamp: 50,
        threadId: "thread-1",
        runId: "1",
        result: { event: "weather.delivered" },
        outcome: { type: "success" },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("provider.invalid");
    expect(JSON.stringify(frames)).not.toContain("secret-token");
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
          args: '{"city":"SF"}',
          result: '{"temperature":71}',
        },
      ],
      custom: [
        {
          type: "CUSTOM",
          timestamp: 20,
          name: "agent-os.chat.ingested",
          value: { runId: 1, intent: "find weather" },
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
      ],
    });
  });

  it("projects a decoded ledger row into an AG-UI envelope with optional frame redaction", () => {
    const event = transcript()[2]!;
    const envelope = projectLedgerEventToAgUiEnvelope(event, {
      mapFrame: (frame) => redactAgUiToolPayloadFrame(frame, "[hidden]"),
    });
    expect(envelope).toMatchObject({
      id: 3,
      ts: 30,
      kind: "llm.response",
      scopeKey: "conversation:ag-ui-test",
    });
    expect(envelope.agUiFrames).toContainEqual({
      type: "TOOL_CALL_ARGS",
      timestamp: 30,
      toolCallId: "call-1",
      delta: "[hidden]",
    });
    expect(framesForAgUiLedgerEnvelope(envelope).at(0)).toMatchObject({
      eventId: 3,
      eventTs: 30,
      eventKind: "llm.response",
      eventScopeKey: "conversation:ag-ui-test",
    });

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
    const envelopes = await collectAsync(projectLedgerSseToAgUiEnvelopes(streamOf(ledgerSse)));
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ id: 1, kind: "agent.run.started" });

    const chunks = await collectAsync(projectLedgerSseToAgUiSse(streamOf(ledgerSse)));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(encodeAgUiLedgerEventEnvelopeSse(envelopes[0]!));
    expect(chunks[0]).toContain("event: ag_ui");
  });

  it("projects AG-UI frames into neutral activities without web-cursor run semantics", () => {
    const activities = projectAgUiFramesToActivities(
      projectLedgerEventsToAgUiFrames(transcript(), { threadId: "thread-1" }),
    );
    expect(activities).toEqual(
      expect.arrayContaining<AgUiActivity>([
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
          args: '{"city":"SF"}',
          result: '{"temperature":71}',
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
      commit(1, agentRunStartedEvent({ scope, intent: "too much" })),
      commit(
        2,
        agentRunAbortedEvent({
          scope,
          kind: "agent.aborted.budget_tokens",
          runId: 1,
          payload: { tokensUsed: 20, tokensMax: 10 },
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

  it("projects product events only through explicit custom extension mapping", () => {
    const frames = projectLedgerEventsToAgUiFrames(
      [
        {
          id: 1,
          ts: 1,
          ...eventIdentity(scope),
          kind: "workspace.file.observed",
          payload: { path: "README.md", content: "not exposed" },
        },
      ],
      {
        projectExtensionEvent: (event) => [
          {
            type: "CUSTOM",
            timestamp: event.ts,
            name: event.kind,
            value: { id: event.id, path: "README.md" },
          },
        ],
      },
    );
    expect(frames).toEqual([
      {
        type: "CUSTOM",
        timestamp: 1,
        name: "workspace.file.observed",
        value: { id: 1, path: "README.md" },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain("not exposed");
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
      deliver: { event: "done" },
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
  });

  it("rejects AG-UI resume until agentOS owns interrupt facts", () => {
    expect(() =>
      agUiRunAgentInputToSubmitSpec(
        {
          threadId: "thread-1",
          runId: "client-run-1",
          messages: [],
          resume: [{ interruptId: "i1", status: "resolved" }],
        },
        {
          route: {
            kind: "openai-chat-compatible",
            endpointRef: "endpoint:openai",
            credentialRef: "credential:openai",
            modelId: "model",
          },
          tools: {},
          deliver: { event: "done" },
        },
      ),
    ).toThrow("AG-UI resume is unsupported");
  });

  it("projects agentOS Tool schemas to AG-UI tool parameters", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup weather",
      args: Schema.Struct({ city: Schema.String }),
      authority: "tool",
      execution: pureToolExecution(),
      admit: () => ({ ok: true }),
      execute: () => ({ temperature: 71 }),
    });
    expect(projectToolToAgUiTool(tool)).toEqual({
      name: "lookup",
      description: "Lookup weather",
      parameters: tool.argsSchema.projections.agUi,
    });
  });
});
