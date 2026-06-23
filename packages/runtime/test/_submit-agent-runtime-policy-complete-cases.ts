import {
  Effect,
  Schema,
  expect,
  it,
  defineTool,
  deterministicToolExecution,
  decodeRuntimeLedgerEvent,
  baseSpec,
  response,
  runSubmit,
} from "./_submit-agent-harness";

export const registerSubmitAgentRuntimePolicyCompleteCases = () => {
  it.effect("does not complete until every runtime-required policy tool executes", () =>
    Effect.gen(function* () {
      const prepare = defineTool({
        name: "prepare",
        description: "prepare workspace",
        args: Schema.Struct({ value: Schema.String }),
        execute: ({ value }) => Effect.succeed({ ok: true, value }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeArtifact = defineTool({
        name: "write_artifact",
        description: "write artifact",
        args: Schema.Struct({ content: Schema.String }),
        execute: ({ content }) => Effect.succeed({ ok: true, content }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: {
            prepare,
            write_artifact: writeArtifact,
          },
          toolPolicy: {
            requiredUntilToolExecuted: { toolName: "prepare" },
            completeAfterToolsExecuted: {
              toolNames: ["write_artifact"],
              finalMessage: "artifact ready",
            },
          },
        }),
        [
          response({
            items: [
              {
                type: "tool_call",
                call: {
                  id: "call-write",
                  type: "function",
                  function: {
                    name: "write_artifact",
                    arguments: '{"content":"artifact"}',
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
                  id: "call-prepare",
                  type: "function",
                  function: {
                    name: "prepare",
                    arguments: '{"value":"ok"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "artifact ready" });
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        { type: "function", function: { name: "prepare" } },
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
      ).toEqual(["write_artifact", "prepare"]);
    }),
  );

  it.effect(
    "rejects repeated declared terminal tools and continues with remaining policy tools",
    () =>
      Effect.gen(function* () {
        let htmlExecutions = 0;
        let designExecutions = 0;
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
          execute: ({ content }) =>
            Effect.sync(() => {
              htmlExecutions++;
              return { ok: true, path: "/output/page.html", content };
            }),
          authority: "write",
          admit: () => Effect.succeed({ ok: true }),
          execution: deterministicToolExecution(),
        });
        const writeDesign = defineTool({
          name: "write_design",
          description: "write design notes",
          args: Schema.Struct({ content: Schema.String }),
          execute: ({ content }) =>
            Effect.sync(() => {
              designExecutions++;
              return { ok: true, path: "/output/DESIGN.md", content };
            }),
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
                      arguments: '{"content":"<html>first</html>"}',
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
                    id: "call-html-duplicate",
                    type: "function",
                    function: {
                      name: "write_html",
                      arguments: '{"content":"<html>duplicate</html>"}',
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
        expect(htmlExecutions).toBe(1);
        expect(designExecutions).toBe(1);
        expect(
          llmRequests.map((request) =>
            (request.tools ?? []).map((tool) => tool.function.name).sort(),
          ),
        ).toEqual([
          ["read_file", "write_design", "write_html"],
          ["read_file", "write_design"],
          ["read_file", "write_design"],
        ]);
        expect(llmRequests.map((request) => request.tool_choice)).toEqual([
          "required",
          { type: "function", function: { name: "write_design" } },
          { type: "function", function: { name: "write_design" } },
        ]);

        const runtimeEvents = events.flatMap((event) => {
          const decoded = decodeRuntimeLedgerEvent(event);
          return decoded._tag === "runtime" ? [decoded.event] : [];
        });
        const executedNames = runtimeEvents
          .filter((event) => event.kind === "tool.executed")
          .map((event) => (event.kind === "tool.executed" ? event.payload.name : ""));
        expect(executedNames).toEqual(["write_html", "write_design"]);
        const rejected = runtimeEvents.find((event) => event.kind === "tool.rejected");
        expect(rejected?.payload).toMatchObject({
          name: "write_html",
          diagnostics: {
            phase: "policy",
            reason: "policy_tool_already_executed",
          },
        });
        expect(JSON.stringify(rejected?.payload)).toContain("policy_denied");
      }),
  );

  it.effect("enforces ordered terminal tool policy after the model starts terminal writes", () =>
    Effect.gen(function* () {
      const executed: string[] = [];
      const readFile = defineTool({
        name: "read_file",
        description: "read file",
        args: Schema.Struct({ path: Schema.String }),
        execute: ({ path }) => Effect.succeed({ path, content: "input" }),
        authority: "read",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeFirst = defineTool({
        name: "write_first",
        description: "write first",
        args: Schema.Struct({ content: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            executed.push("write_first");
            return { ok: true };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeSecond = defineTool({
        name: "write_second",
        description: "write second",
        args: Schema.Struct({ content: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            executed.push("write_second");
            return { ok: true };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });
      const writeThird = defineTool({
        name: "write_third",
        description: "write third",
        args: Schema.Struct({ content: Schema.String }),
        execute: () =>
          Effect.sync(() => {
            executed.push("write_third");
            return { ok: true };
          }),
        authority: "write",
        admit: () => Effect.succeed({ ok: true }),
        execution: deterministicToolExecution(),
      });

      const { result, events, llmRequests } = yield* runSubmit(
        baseSpec({
          tools: {
            read_file: readFile,
            write_first: writeFirst,
            write_second: writeSecond,
            write_third: writeThird,
          },
          toolPolicy: {
            completeAfterToolsExecuted: {
              toolNames: ["write_first", "write_second", "write_third"],
              ordered: true,
              finalMessage: "ordered artifacts written",
            },
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
                  id: "call-second-early",
                  type: "function",
                  function: {
                    name: "write_second",
                    arguments: '{"content":"too early"}',
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
                  id: "call-first",
                  type: "function",
                  function: {
                    name: "write_first",
                    arguments: '{"content":"first"}',
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
                  id: "call-second",
                  type: "function",
                  function: {
                    name: "write_second",
                    arguments: '{"content":"second"}',
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
                  id: "call-third",
                  type: "function",
                  function: {
                    name: "write_third",
                    arguments: '{"content":"third"}',
                  },
                },
              },
            ],
          }),
        ],
      );

      expect(result).toMatchObject({ ok: true, final: "ordered artifacts written" });
      expect(executed).toEqual(["write_first", "write_second", "write_third"]);
      expect(llmRequests.map((request) => request.tool_choice)).toEqual([
        "required",
        "required",
        "required",
        { type: "function", function: { name: "write_second" } },
        { type: "function", function: { name: "write_third" } },
      ]);
      const rejected = events
        .map((event) => decodeRuntimeLedgerEvent(event))
        .find((decoded) => decoded._tag === "runtime" && decoded.event.kind === "tool.rejected");
      expect(
        rejected?._tag === "runtime" && rejected.event.kind === "tool.rejected"
          ? rejected.event.payload.diagnostics
          : undefined,
      ).toMatchObject({
        phase: "policy",
        reason: "policy_tool_out_of_order",
      });
    }),
  );
};
