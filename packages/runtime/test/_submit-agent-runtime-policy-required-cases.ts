import {
  Effect,
  Schema,
  expect,
  it,
  defineTool,
  deterministicToolExecution,
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  baseSpec,
  response,
  runSubmit,
  decodedRuntimeEvents,
} from "./_submit-agent-harness";

export const registerSubmitAgentRuntimePolicyRequiredCases = () => {
  it.effect("requires tool calls until the declared terminal tool executes", () =>
    Effect.gen(function* () {
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeTerminal = defineTool({
        name: "write_terminal",
        description: "write terminal result",
        args: Schema.Struct({ value: Schema.String }),
        execute: ({ value }) => Effect.succeed({ ok: true, value }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: { read_file: readFile, write_terminal: writeTerminal },
          toolPolicy: {
            requiredUntilToolExecuted: { toolName: "write_terminal" },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"input.json"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_terminal",
                    arguments: '{"value":"done"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        undefined,
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed")
          .map((decoded) =>
            decoded._tag === "runtime" && decoded.event.kind === "tool.executed"
              ? decoded.event.payload.name
              : "",
          ),
      ).toEqual(["read_file", "write_terminal"]);
    }),
  );

  it.effect("does not complete from prose while a declared required tool is missing", () =>
    Effect.gen(function* () {
      const writeTerminal = defineTool({
        name: "write_terminal",
        description: "write terminal result",
        args: Schema.Struct({ value: Schema.String }),
        execute: ({ value }) => Effect.succeed({ ok: true, value }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: { write_terminal: writeTerminal },
          toolPolicy: {
            requiredUntilToolExecuted: { toolName: "write_terminal" },
          },
        }),
        [
          response({ items: [{ type: "message", text: "I am done without a tool." }] }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_terminal",
                    arguments: '{"value":"done"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "done" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "done" });
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        undefined,
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter(
            (decoded) =>
              decoded._tag === "runtime" &&
              (decoded.event.kind === "tool.executed" ||
                decoded.event.kind === "agent.run.completed"),
          )
          .map((decoded) => (decoded._tag === "runtime" ? decoded.event.kind : "unknown")),
      ).toEqual(["tool.executed", "agent.run.completed"]);
    }),
  );

  it.effect("completes after every declared terminal tool executes", () =>
    Effect.gen(function* () {
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeHtml = defineTool({
        name: "write_html",
        description: "write html",
        args: Schema.Struct({ content: Schema.String }),
        execute: ({ content }) => Effect.succeed({ ok: true, path: "/output/page.html", content }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeDesign = defineTool({
        name: "write_design",
        description: "write design notes",
        args: Schema.Struct({ content: Schema.String }),
        execute: ({ content }) => Effect.succeed({ ok: true, path: "/output/DESIGN.md", content }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: {
            read_file: readFile,
            write_html: writeHtml,
            write_design: writeDesign,
          },
          toolPolicy: {
            completeAfterToolsExecuted: {
              invocation: "required",
              toolNames: ["write_html", "write_design"],
              finalMessage: "artifacts written",
            },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-html",
                  type: "function",
                  function: {
                    name: "write_html",
                    arguments: '{"content":"<html></html>"}',
                  },
                },
              },
            ],
          }),
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-design",
                  type: "function",
                  function: {
                    name: "write_design",
                    arguments: '{"content":"# Design"}',
                  },
                },
              },
            ],
          }),
          response({ items: [{ type: "message", text: "should not be called" }] }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "artifacts written" });
      expect(
        llmRequests.map((request) =>
          (request.tools ?? []).map((tool) => tool.function.name).sort(),
        ),
      ).toEqual([
        ["read_file", "write_design", "write_html"],
        ["read_file", "write_design"],
      ]);
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        { type: "function", function: { name: "write_design" } },
      ]);
      expect(
        events
          .map((event) => decodeRuntimeLedgerEvent(event))
          .filter((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.executed")
          .map((decoded) =>
            decoded._tag === "runtime" && decoded.event.kind === "tool.executed"
              ? decoded.event.payload.name
              : "",
          ),
      ).toEqual(["write_html", "write_design"]);
      expect(
        decodedRuntimeEvents(events)
          .filter(
            (event) =>
              event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED ||
              event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE ||
              event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED ||
              event.kind === RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS ||
              event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
          )
          .map((event) => event.kind),
      ).toEqual([
        RUNTIME_EVENT_KIND.LLM_REQUESTED,
        RUNTIME_EVENT_KIND.LLM_RESPONSE,
        RUNTIME_EVENT_KIND.TOOL_EXECUTED,
        RUNTIME_EVENT_KIND.LLM_REQUESTED,
        RUNTIME_EVENT_KIND.LLM_RESPONSE,
        RUNTIME_EVENT_KIND.TOOL_EXECUTED,
        RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS,
        RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED,
      ]);
      expect(
        decodedRuntimeEvents(events)
          .filter((event) => event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED)
          .map((event) =>
            event.kind === RUNTIME_EVENT_KIND.LLM_REQUESTED ? event.payload : undefined,
          ),
      ).toEqual([
        expect.objectContaining({
          runId: 1,
          turn: { id: 1, index: 0 },
          modelId: "test-model",
          toolNames: ["read_file", "write_html", "write_design"],
          toolChoice: "required",
        }),
        expect.objectContaining({
          runId: 1,
          turn: { id: 1, index: 1 },
          modelId: "test-model",
          toolNames: ["read_file", "write_design"],
          toolChoice: "function:write_design",
        }),
      ]);
      expect(
        decodedRuntimeEvents(events).find(
          (event) => event.kind === RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS,
        )?.payload,
      ).toEqual(
        expect.objectContaining({
          runId: 1,
          turn: { id: 1, index: 1 },
          toolNames: ["write_html", "write_design"],
          tokensUsed: 4,
        }),
      );
    }),
  );
};
