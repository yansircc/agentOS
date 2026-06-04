import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  defineTool,
  defineToolFromDefinition,
  deterministicToolInvocation,
  executeTool,
  pureToolExecution,
  runToolByName,
  validateToolRegistry,
  type Tool,
} from "../src/tools";
import type { LlmToolCall } from "../src/llm";

describe("defineTool", () => {
  it("derives the OpenAI tool parameters and args decoder from one Schema", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup a symbolic key",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: "allow",
      execution: pureToolExecution(),
      execute: ({ key }) => ({ value: key }),
    });

    expect(tool.definition).toEqual({
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup a symbolic key",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    });
    expect(tool.decode({ key: "abc" })).toEqual({ key: "abc" });
    expect(() => tool.decode({ key: 1 })).toThrow();
  });

  it("requires explicit admission", () => {
    expect(() =>
      defineTool({
        name: "lookup",
        description: "Lookup a symbolic key",
        args: Schema.Struct({ key: Schema.String }),
        authority: "read",
        admit: undefined as never,
        execution: pureToolExecution(),
        execute: ({ key }) => ({ value: key }),
      }),
    ).toThrow("tool admitter is required");
  });

  it("rejects Effect Schema features outside the closed JSON Schema dialect", () => {
    expect(() =>
      defineTool({
        name: "lookup",
        description: "Lookup a symbolic key",
        args: Schema.Struct({ key: Schema.String.pipe(Schema.minLength(1)) }),
        authority: "read",
        admit: "allow",
        execution: pureToolExecution(),
        execute: ({ key }) => ({ value: key }),
      }),
    ).toThrow("unsupported");
  });
});

describe("defineToolFromDefinition", () => {
  it("closes manifest tool schemas and validates args before custom decode", () => {
    let decoded = false;
    const tool = defineToolFromDefinition({
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup a symbolic key",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
        },
      },
      decode: (args) => {
        decoded = true;
        return args as { readonly key: string };
      },
      authorityClass: "read",
      admit: "allow",
      execution: pureToolExecution(),
      execute: async ({ key }) => ({ value: key }),
    });

    expect(tool.decode({ key: "abc" })).toEqual({ key: "abc" });
    expect(decoded).toBe(true);
    decoded = false;
    expect(() => tool.decode({ key: 1 })).toThrow("violate schema");
    expect(decoded).toBe(false);
  });

  it("rejects manifest schemas outside the closed dialect", () => {
    expect(() =>
      defineToolFromDefinition({
        definition: {
          type: "function",
          function: {
            name: "lookup",
            description: "Lookup a symbolic key",
            parameters: {
              type: "object",
              properties: {
                key: { type: "string", minLength: 1 },
              },
            },
          },
        },
        authorityClass: "read",
        admit: "allow",
        execution: pureToolExecution(),
        execute: async () => null,
      }),
    ).toThrow("unsupported-key");
  });

  it.effect("passes AbortSignal through executeTool", () =>
    Effect.gen(function* () {
      let observed: AbortSignal | undefined;
      const tool = defineTool({
        name: "lookup",
        description: "Lookup",
        args: Schema.Struct({ key: Schema.String }),
        authority: "read",
        admit: "allow",
        execution: pureToolExecution(),
        execute: (_args, ctx) => {
          observed = ctx.signal;
          return { ok: true };
        },
      });

      const result = yield* executeTool(tool, { key: "abc" }, "lookup");
      expect(result).toEqual({ ok: true });
      expect(observed).toBeInstanceOf(AbortSignal);
    }),
  );

  it("rejects missing execution in registry validation", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: "allow",
      execution: pureToolExecution(),
      execute: ({ key }) => ({ value: key }),
    });
    const legacy = {
      ...tool,
      contract: { ...tool.contract, execution: undefined },
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: legacy })).toEqual({
      ok: false,
      issues: [
        { kind: "unregistered_contract", toolId: "lookup" },
        { kind: "missing_execution", toolId: "lookup" },
      ],
    });
  });
});

describe("runToolByName", () => {
  it.effect("runs deterministic product-side tool invocations", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "Lookup a symbolic key",
        args: Schema.Struct({ key: Schema.String }),
        authority: "read",
        admit: "allow",
        execution: pureToolExecution(),
        execute: ({ key }) => ({ value: key }),
      });

      const result = yield* runToolByName(
        { lookup: tool },
        deterministicToolInvocation("lookup", { key: "abc" }),
      );

      expect(result).toEqual({ value: "abc" });
    }),
  );

  it.effect("fails unknown tools and invalid args as ToolError", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "Lookup a symbolic key",
        args: Schema.Struct({ key: Schema.String }),
        authority: "read",
        admit: "allow",
        execution: pureToolExecution(),
        execute: ({ key }) => ({ value: key }),
      });

      const unknown = yield* Effect.either(
        runToolByName({ lookup: tool }, deterministicToolInvocation("missing", {})),
      );
      expect(unknown._tag).toBe("Left");
      if (unknown._tag === "Left") {
        expect(unknown.left.cause).toEqual({ reason: "unknown_tool" });
      }

      const invalid = yield* Effect.either(
        runToolByName({ lookup: tool }, deterministicToolInvocation("lookup", { key: 1 })),
      );
      expect(invalid._tag).toBe("Left");
      if (invalid._tag === "Left") {
        expect(invalid.left.cause).toEqual({
          reason: "invalid_args",
          decodeError: "TypeError",
        });
      }
    }),
  );

  it("rejects LLM tool-call envelopes at type level", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup a symbolic key",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: "allow",
      execution: pureToolExecution(),
      execute: ({ key }) => ({ value: key }),
    });
    const llmCall: LlmToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "lookup", arguments: '{"key":"abc"}' },
    };

    // @ts-expect-error LLM-selected tool calls must go through submit().
    const rejected = () => runToolByName({ lookup: tool }, llmCall);
    void rejected;

    expect(llmCall.function.name).toBe("lookup");
  });
});
