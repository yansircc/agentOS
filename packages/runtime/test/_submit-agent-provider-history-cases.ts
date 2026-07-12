import {
  Effect,
  Fiber,
  Schema,
  TestClock,
  expect,
  it,
  defineTool,
  deterministicToolExecution,
  ToolError,
  decodeRuntimeLedgerEvent,
  projectFailureDiagnostics,
  RUNTIME_EVENT_KIND,
  baseSpec,
  response,
  runSubmit,
  decodedRuntimeBehaviorKinds,
  decodedRuntimeEvents,
} from "./_submit-agent-harness";
import { captureLive } from "@agent-os/core/live-edge";

export const registerSubmitAgentProviderHistoryCases = () => {
  it.effect(
    "keeps live assistant continuation out of ledger and on the next provider request",
    () =>
      Effect.gen(function* () {
        const tool = defineTool({
          name: "lookup",
          description: "lookup",
          args: Schema.Struct({ q: Schema.String }),
          execute: () => Effect.succeed({ ok: true }),
          authority: "read",
          admit: () => Effect.succeed({ ok: true }),
          execution: deterministicToolExecution(),
        });
        const continuation = {
          kind: "live" as const,
          binding: {
            adapterId: "openai-chat-compatible@v1",
            adapterVersion: "v1",
            routeFingerprint: "route-v1",
            modelFingerprint: "model-v1",
            truthIdentityFingerprint: "tenant-a",
            sourceTurn: { id: 1, index: 0 },
            successorTurn: { id: 1, index: 1 },
          },
          payload: captureLive({
            reasoning_content: "private-reasoning",
            encrypted_content: "encrypted-token",
          }),
        };
        const { result, events, llmRequests } = yield* runSubmit(
          baseSpec({ tools: { lookup: tool } }),
          [
            response({
              items: [
                {
                  type: "tool_call",
                  call: {
                    id: "call-1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"x"}' },
                  },
                },
              ],
              continuation: { kind: "available", value: continuation },
            }),
            response({ items: [{ type: "message", text: "done" }] }),
          ],
        );

        expect(result).toMatchObject({ ok: true, final: "done" });
        const assistant = llmRequests[1]?.messages.find((message) => message.role === "assistant");
        expect(assistant).toMatchObject({
          role: "assistant",
          continuation: { kind: "live", binding: continuation.binding },
        });
        const ledgerJson = JSON.stringify(events);
        expect(ledgerJson).toContain('"required":true');
        expect(ledgerJson).not.toContain("private-reasoning");
        expect(ledgerJson).not.toContain("encrypted-token");
      }),
  );

  it.effect("known tool schema decode failure feeds sanitized diagnostics back to the model", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "write_file",
        description: "write file",
        args: Schema.Struct({ path: Schema.String, content: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(baseSpec({ tools: { write_file: tool } }), [
        response({
          items: [
            { type: "message", text: "write" },
            {
              type: "tool_call",
              call: {
                id: "call-1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: '{"path":"out.txt"}',
                },
              },
            },
          ],
        }),
        response({
          items: [
            { type: "message", text: "retry write" },
            {
              type: "tool_call",
              call: {
                id: "call-2",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: '{"path":"out.txt","content":"ok"}',
                },
              },
            },
          ],
        }),
        response({ items: [{ type: "message", text: "done" }] }),
      ]);

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "llm.response",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);
      const rejected = events.find((event) => event.kind === "tool.rejected");
      expect(decodeRuntimeLedgerEvent(rejected!)).toMatchObject({
        _tag: "runtime",
        event: {
          payload: {
            name: "write_file",
            diagnostics: {
              phase: "decode",
              reason: "invalid_args",
              argumentSummary: {
                type: "object",
                keys: ["path"],
                truncated: false,
              },
            },
          },
        },
      });
      expect(JSON.stringify(events)).toContain("content");
    }),
  );

  it.effect("compacts executed tool arguments before the next provider request", () =>
    Effect.gen(function* () {
      const largeContent = `<main>${"export golf cart ".repeat(1_500)}</main>`;
      const tool = defineTool({
        name: "write_file",
        description: "write a file",
        args: Schema.Struct({ content: Schema.String }),
        execute: (args) => Effect.succeed({ bytesWritten: args.content.length }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({ tools: { write_file: tool } }),
        [
          response({
            items: [
              { type: "message", text: "write mockup" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ content: largeContent }),
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      const runtimeEvents = decodedRuntimeEvents(events);
      const compaction = runtimeEvents.find(
        (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED,
      );
      expect(compaction).toBeDefined();
      if (compaction?.kind !== RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED) {
        expect.fail("expected runtime.history_compacted event");
      }
      expect(compaction.payload).toMatchObject({
        runId: 1,
        turn: { id: 1, index: 0 },
        target: {
          kind: "tool_call_arguments",
          toolCallId: "call-1",
          toolName: "write_file",
        },
        strategy: "provider_history_string_redaction",
      });
      expect(compaction.payload.compactedBytes).toBeLessThan(compaction.payload.originalBytes);
      expect(compaction.id).toBeGreaterThan(compaction.payload.sourceEventId);
      const sourceEvent = runtimeEvents.find(
        (event) => event.id === compaction.payload.sourceEventId,
      );
      expect(sourceEvent?.kind).toBe(RUNTIME_EVENT_KIND.LLM_RESPONSE);
      expect(JSON.stringify(sourceEvent)).toContain(largeContent.slice(0, 120));

      const secondMessages = llmRequests[1]?.messages ?? [];
      const secondRequestMessages = JSON.stringify(secondMessages);
      const assistantMessage = secondMessages.find(
        (message) =>
          message.role === "assistant" && message.tool_calls?.some((call) => call.id === "call-1"),
      );
      const compactedArgumentsJson = assistantMessage?.tool_calls?.find(
        (call) => call.id === "call-1",
      )?.function.arguments;
      expect(compactedArgumentsJson).toBeDefined();
      const compactedArguments = JSON.parse(compactedArgumentsJson!);
      expect(compactedArguments).toEqual({
        content: expect.stringContaining("agentOS redacted provider history string"),
      });
      expect(secondRequestMessages).toContain("bytesWritten");
      expect(secondRequestMessages).not.toContain("provider_history_tool_arguments");
      expect(secondRequestMessages).not.toContain("originalBytes");
      expect(secondRequestMessages).not.toContain(largeContent.slice(0, 120));
    }),
  );

  it.effect("does not record provider history compaction for JSON minify without redaction", () =>
    Effect.gen(function* () {
      const originalArguments = JSON.stringify({ content: "short value" }, null, 2);
      const tool = defineTool({
        name: "write_file",
        description: "write a file",
        args: Schema.Struct({ content: Schema.String }),
        execute: (args) => Effect.succeed({ bytesWritten: args.content.length }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({ tools: { write_file: tool } }),
        [
          response({
            items: [
              { type: "message", text: "write small file" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: originalArguments,
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      expect(
        decodedRuntimeEvents(events).find(
          (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED,
        ),
      ).toBeUndefined();
      const assistantMessage = llmRequests[1]?.messages.find(
        (message) =>
          message.role === "assistant" && message.tool_calls?.some((call) => call.id === "call-1"),
      );
      expect(
        assistantMessage?.tool_calls?.find((call) => call.id === "call-1")?.function.arguments,
      ).toBe(originalArguments);
    }),
  );

  it.effect("compacts nested provider history strings when any nested value is redacted", () =>
    Effect.gen(function* () {
      const largeContent = `<section>${"nested provider history ".repeat(1_000)}</section>`;
      const tool = defineTool({
        name: "write_sections",
        description: "write sections",
        args: Schema.Struct({
          sections: Schema.Array(Schema.Struct({ html: Schema.String })),
          meta: Schema.Struct({ notes: Schema.Array(Schema.String) }),
        }),
        execute: (args) => Effect.succeed({ sections: args.sections.length }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({ tools: { write_sections: tool } }),
        [
          response({
            items: [
              { type: "message", text: "write sections" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_sections",
                    arguments: JSON.stringify({
                      sections: [{ html: largeContent }],
                      meta: { notes: ["small", largeContent] },
                    }),
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      const compaction = decodedRuntimeEvents(events).find(
        (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED,
      );
      expect(compaction).toBeDefined();
      const assistantMessage = llmRequests[1]?.messages.find(
        (message) =>
          message.role === "assistant" && message.tool_calls?.some((call) => call.id === "call-1"),
      );
      const compactedArgumentsJson = assistantMessage?.tool_calls?.find(
        (call) => call.id === "call-1",
      )?.function.arguments;
      expect(compactedArgumentsJson).toBeDefined();
      const compactedArguments = JSON.parse(compactedArgumentsJson!);
      expect(compactedArguments.sections[0].html).toContain(
        "agentOS redacted provider history string",
      );
      expect(compactedArguments.meta.notes[1]).toContain(
        "agentOS redacted provider history string",
      );
      expect(JSON.stringify(llmRequests[1]?.messages ?? [])).not.toContain(
        largeContent.slice(0, 120),
      );
    }),
  );

  it.effect("keeps provider history unchanged when redacted arguments fail tool decoding", () =>
    Effect.gen(function* () {
      const largeContent = `<main>${"literal-only ".repeat(1_000)}</main>`;
      const tool = defineTool({
        name: "write_literal",
        description: "write a literal",
        args: Schema.Struct({ content: Schema.Literal(largeContent) }),
        execute: (args) => Effect.succeed({ bytesWritten: args.content.length }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({ tools: { write_literal: tool } }),
        [
          response({
            items: [
              { type: "message", text: "write literal" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "write_literal",
                    arguments: JSON.stringify({ content: largeContent }),
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, status: "delivered" });
      expect(
        decodedRuntimeEvents(events).find(
          (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED,
        ),
      ).toBeUndefined();
      const secondRequestMessages = JSON.stringify(llmRequests[1]?.messages ?? []);
      expect(secondRequestMessages).toContain(largeContent.slice(0, 120));
      expect(secondRequestMessages).not.toContain("agentOS redacted provider history string");
    }),
  );

  it.effect("known tool JSON parse failure aborts when validation retry budget is exhausted", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () => Effect.succeed({ ok: true }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events } = yield* runSubmit(
        baseSpec({
          tools: { lookup: tool },
          budget: { toolRetryPolicy: { correctionRetries: 0 } },
        }),
        [
          response({
            items: [
              { type: "message", text: "lookup" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":' },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: false, reason: "tool_error" });
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.rejected",
        "agent.aborted.tool_error",
      ]);
      expect(projectFailureDiagnostics(events, 1)).toMatchObject({
        diagnostics: [
          {
            source: "tool",
            phase: "parse",
            reason: "invalid_args",
            toolName: "lookup",
            toolCallId: "call-1",
          },
        ],
      });
    }),
  );

  it.effect("tool execution retry policy derives delayed execution retries", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const tool = defineTool({
        name: "lookup",
        description: "lookup",
        args: Schema.Struct({ q: Schema.String }),
        execute: () =>
          Effect.gen(function* () {
            attempts += 1;
            if (attempts === 1) {
              return yield* new ToolError({
                toolName: "lookup",
                cause: { reason: "transient_lookup_failure" },
              });
            }
            return { ok: true };
          }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const fiber = yield* runSubmit(
        baseSpec({
          tools: { lookup: tool },
          budget: {
            toolRetryPolicy: {
              execution: {
                maxRetries: 1,
                delay: { kind: "fixed", delayMs: 1_000, jitter: false },
              },
            },
          },
        }),
        [
          response({
            items: [
              { type: "message", text: "lookup" },
              {
                type: "tool_call",
                call: {
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: '{"q":"x"}' },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(attempts).toBe(1);
      yield* TestClock.adjust("999 millis");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 millis");

      const { result, events } = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ ok: true, status: "delivered" });
      expect(attempts).toBe(2);
      expect(decodedRuntimeBehaviorKinds(events)).toEqual([
        "agent.run.started",
        "chat.ingested",
        "llm.response",
        "tool.executed",
        "llm.response",
        "agent.run.completed",
      ]);
    }),
  );
};
