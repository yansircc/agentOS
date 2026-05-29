import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { defineTool } from "../src/tools";

describe("defineTool", () => {
  it("derives the OpenAI tool parameters and args decoder from one Schema", () => {
    const tool = defineTool({
      name: "lookup",
      description: "Lookup a symbolic key",
      args: Schema.Struct({ key: Schema.String }),
      authority: "read",
      admit: "allow",
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
        execute: ({ key }) => ({ value: key }),
      }),
    ).toThrow("unsupported-key");
  });
});
