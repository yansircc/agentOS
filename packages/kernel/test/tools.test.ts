import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  defineTool,
  deterministicToolInvocation,
  executeTool,
  pureToolExecution,
  unsafeRunToolByName,
  validateExecutionDomainRegistry,
  validateToolRegistry,
  type ToolCall,
  type Tool,
} from "../src/tools";

const allowToolAdmitter = () => Effect.succeed({ ok: true as const });

describe("defineTool", () => {
  it("derives tool parameters and args decoder from one Schema", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup a symbolic key",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: pureToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });

    expect(tool.definition.function.parameters).toBe(tool.argsSchema);
    expect(tool.definition).toMatchObject({
      type: "function",
      function: {
        name: "lookup",
        description: "Lookup a symbolic key",
      },
    });
    expect(tool.definition.function.parameters.projections.canonical).toEqual({
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
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
        execute: ({ key }) => Effect.succeed({ value: key }),
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
        admit: allowToolAdmitter,
        execution: pureToolExecution(),
        execute: ({ key }) => Effect.succeed({ value: key }),
      }),
    ).toThrow("unsupported");
  });
  it.effect("passes resolved materials through executeTool", () =>
    Effect.gen(function* () {
      let observedMaterials: unknown;
      const tool = defineTool({
        name: "lookup",
        description: "Lookup",
        args: Schema.Struct({ key: Schema.String }),
        authority: "read",
        admit: allowToolAdmitter,
        execution: pureToolExecution(),
        execute: (_args, ctx) => {
          observedMaterials = ctx.materials;
          return Effect.succeed({ ok: true });
        },
      });

      const result = yield* executeTool(tool, { key: "abc" }, "lookup", {
        api_token: "resolved-secret",
      });
      expect(result).toEqual({ ok: true });
      expect(observedMaterials).toEqual({ api_token: "resolved-secret" });
    }),
  );

  it("rejects missing execution in registry validation", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: pureToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });
    const legacy = {
      ...tool,
      execution: undefined,
    } as unknown as Tool;

    expect(validateToolRegistry({ lookup: legacy })).toEqual({
      ok: false,
      issues: [{ kind: "missing_execution", toolId: "lookup" }],
    });
  });

  it("keeps execution out of the claim contract", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: pureToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });

    expect(tool.execution).toEqual({ kind: "pure" });
    expect("execution" in tool.contract).toBe(false);
    // @ts-expect-error execution is a Tool sibling, not ToolContract data.
    expect(tool.contract.execution).toBeUndefined();
  });
});

describe("ExecutionDomainRegistry", () => {
  it("allows pure tools without a domain declaration", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: pureToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });

    expect(validateExecutionDomainRegistry({ lookup: tool }, { domains: [] })).toEqual({
      ok: true,
    });
  });

  it("rejects missing and duplicate effectful domain declarations", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: { kind: "effectful", domain },
      execute: ({ path }) => Effect.succeed({ path }),
    });

    expect(validateExecutionDomainRegistry({ write_file: tool }, { domains: [] })).toEqual({
      ok: false,
      issues: [{ kind: "missing_declaration", toolId: "write_file", domain }],
    });

    expect(
      validateExecutionDomainRegistry({ write_file: tool }, { domains: [{ domain }, { domain }] }),
    ).toEqual({
      ok: false,
      issues: [{ kind: "duplicate_declaration", domain }],
    });
  });

  it("rejects host declarations without an env allowlist", () => {
    expect(
      validateExecutionDomainRegistry(
        {},
        {
          domains: [
            {
              domain: { kind: "host", ref: "local" } as never,
            },
          ],
        },
      ),
    ).toEqual({
      ok: false,
      issues: [{ kind: "invalid_declaration", index: 0 }],
    });
  });
});

describe("unsafeRunToolByName", () => {
  it.effect("runs deterministic product-side tool invocations", () =>
    Effect.gen(function* () {
      const tool = defineTool({
        name: "lookup",
        description: "Lookup a symbolic key",
        args: Schema.Struct({ key: Schema.String }),
        authority: "read",
        admit: allowToolAdmitter,
        execution: pureToolExecution(),
        execute: ({ key }) => Effect.succeed({ value: key }),
      });

      const result = yield* unsafeRunToolByName(
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
        admit: allowToolAdmitter,
        execution: pureToolExecution(),
        execute: ({ key }) => Effect.succeed({ value: key }),
      });

      const unknown = yield* Effect.either(
        unsafeRunToolByName({ lookup: tool }, deterministicToolInvocation("missing", {})),
      );
      expect(unknown._tag).toBe("Left");
      if (unknown._tag === "Left") {
        expect(unknown.left.cause).toEqual({ reason: "unknown_tool" });
      }

      const invalid = yield* Effect.either(
        unsafeRunToolByName({ lookup: tool }, deterministicToolInvocation("lookup", { key: 1 })),
      );
      expect(invalid._tag).toBe("Left");
      if (invalid._tag === "Left") {
        expect(invalid.left.cause).toEqual({
          reason: "invalid_args",
          decodeError: "AgentSchemaDecodeError",
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
      admit: allowToolAdmitter,
      execution: pureToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });
    const llmCall: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "lookup", arguments: '{"key":"abc"}' },
    };

    // @ts-expect-error LLM-selected tool calls must go through submit().
    const rejected = () => unsafeRunToolByName({ lookup: tool }, llmCall);
    void rejected;

    expect(llmCall.function.name).toBe("lookup");
  });
});
