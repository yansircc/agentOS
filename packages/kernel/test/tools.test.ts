import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  defineTool,
  defineProductTool,
  deterministicToolInvocation,
  executeTool,
  deterministicToolExecution,
  externalToolExecution,
  resolveToolExecution,
  unsafeRunToolByName,
  validateExecutionDomainRegistry,
  validateToolRegistry,
  withToolWriteRequirement,
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
      execution: deterministicToolExecution(),
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
        execution: deterministicToolExecution(),
        execute: ({ key }) => Effect.succeed({ value: key }),
      }),
    ).toThrow("tool admitter is required");
  });

  it("rejects Effect Schema features outside the closed JSON Schema dialect", () => {
    expect(() =>
      defineTool({
        name: "lookup",
        description: "Lookup a symbolic key",
        args: Schema.Struct({ key: Schema.String.pipe(Schema.brand("LookupKey")) }),
        authority: "read",
        admit: allowToolAdmitter,
        execution: deterministicToolExecution(),
        execute: ({ key }) => Effect.succeed({ value: key }),
      }),
    ).toThrow("unsupported");
  });

  it("supports bounded string tool argument contracts", () => {
    const tool = defineTool({
      name: "append_file",
      description: "Append bounded content to a file",
      args: Schema.Struct({
        path: Schema.String,
        content: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8)),
      }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: deterministicToolExecution(),
      execute: ({ content }) => Effect.succeed({ bytes: content.length }),
    });

    expect(tool.definition.function.parameters.projections.canonical).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", minLength: 1, maxLength: 8 },
      },
      required: ["path", "content"],
      additionalProperties: false,
    });
    expect(tool.decode({ path: "input/editor.json", content: "chunk" })).toEqual({
      path: "input/editor.json",
      content: "chunk",
    });
    expect(() => tool.decode({ path: "input/editor.json", content: "" })).toThrow("minLength");
    expect(() => tool.decode({ path: "input/editor.json", content: "too-long-content" })).toThrow(
      "maxLength",
    );
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
        execution: deterministicToolExecution(),
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
      execution: deterministicToolExecution(),
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
      execution: deterministicToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });

    expect(tool.execution).toEqual({ kind: "deterministic" });
    expect("execution" in tool.contract).toBe(false);
    // @ts-expect-error execution is a Tool sibling, not ToolContract data.
    expect(tool.contract.execution).toBeUndefined();
  });
});

describe("defineProductTool", () => {
  it.effect("defaults to pure Effect execution without a Promise waiter boundary", () =>
    Effect.gen(function* () {
      const tool = defineProductTool({
        name: "refresh_view",
        description: "Refresh a product view",
        args: Schema.Struct({ projectionId: Schema.String }),
        authority: "product",
        admit: allowToolAdmitter,
        execute: ({ projectionId }) => Effect.succeed({ projectionId, refreshed: true }),
      });

      expect(tool.execution).toEqual({ kind: "deterministic" });
      const result = yield* executeTool(tool, { projectionId: "run:r1" }, "refresh_view");
      expect(result).toEqual({ projectionId: "run:r1", refreshed: true });
    }),
  );
});

describe("ExecutionDomainRegistry", () => {
  it("allows deterministic tools without a domain declaration", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: allowToolAdmitter,
      execution: deterministicToolExecution(),
      execute: ({ key }) => Effect.succeed({ value: key }),
    });

    expect(validateExecutionDomainRegistry({ lookup: tool }, { domains: [] })).toEqual({
      ok: true,
    });
  });

  it("rejects missing and duplicate external domain replay laws", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const writeReceipt = { domain, replay: { access: "write" as const, witness: "receipt" as const } };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: externalToolExecution("write", domain),
      execute: ({ path }) => withToolWriteRequirement(Effect.succeed({ path })),
    });

    expect(validateExecutionDomainRegistry({ write_file: tool }, { domains: [] })).toEqual({
      ok: false,
      issues: [{ kind: "missing_declaration", toolId: "write_file", domain, access: "write" }],
    });

    expect(
      validateExecutionDomainRegistry(
        { write_file: tool },
        { domains: [writeReceipt, writeReceipt] },
      ),
    ).toEqual({
      ok: false,
      issues: [{ kind: "duplicate_declaration", domain, access: "write" }],
    });
  });

  it("rejects access-mismatched and write snapshot replay laws", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };
    const tool = defineTool({
      name: "write_file",
      description: "Write",
      args: Schema.Struct({ path: Schema.String }),
      authority: "write",
      admit: allowToolAdmitter,
      execution: externalToolExecution("write", domain),
      execute: ({ path }) => withToolWriteRequirement(Effect.succeed({ path })),
    });

    expect(
      validateExecutionDomainRegistry(
        { write_file: tool },
        { domains: [{ domain, replay: { access: "read", witness: "snapshot" } }] },
      ),
    ).toEqual({
      ok: false,
      issues: [
        {
          kind: "access_mismatch",
          toolId: "write_file",
          domain,
          access: "write",
          declaredAccesses: ["read"],
        },
      ],
    });

    expect(
      validateExecutionDomainRegistry(
        { write_file: tool },
        { domains: [{ domain, replay: { access: "write", witness: "snapshot" } }] },
      ),
    ).toEqual({
      ok: false,
      issues: [{ kind: "invalid_write_snapshot_law", domain }],
    });
  });

  it("resolves replay witness only from the domain law", () => {
    const domain = { kind: "workspace" as const, ref: "workspace:default" };

    expect(
      resolveToolExecution(externalToolExecution("read", domain), {
        domains: [{ domain, replay: { access: "read", witness: "receipt" } }],
      }),
    ).toMatchObject({
      ok: true,
      resolved: {
        kind: "external",
        witness: "receipt",
        execution: { kind: "external", access: "read", domain },
      },
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
              replay: { access: "read", witness: "snapshot" },
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
        execution: deterministicToolExecution(),
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
        execution: deterministicToolExecution(),
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
          schemaIssues: [{ path: "$.key", issue: "not-string" }],
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
      execution: deterministicToolExecution(),
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
