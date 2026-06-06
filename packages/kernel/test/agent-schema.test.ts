import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  AgentSchemaProfileError,
  defineAgentSchema,
  fingerprintAgentSchema,
  inspectAgentSchemaProfile,
} from "../src/agent-schema";

describe("AgentSchema profile spike", () => {
  it.effect("decodes, fingerprints, and projects the supported fixture matrix", () =>
    Effect.gen(function* () {
      const schema = defineAgentSchema(
        Schema.Struct({
          text: Schema.String,
          score: Schema.Number,
          accepted: Schema.Boolean,
          tags: Schema.Array(Schema.String),
          mode: Schema.Literal("fast", "slow"),
          scalar: Schema.Union(Schema.String, Schema.Number),
        }),
      );

      expect(
        schema.decode({
          text: "ok",
          score: 1,
          accepted: true,
          tags: ["a"],
          mode: "fast",
          scalar: "x",
        }),
      ).toEqual({
        text: "ok",
        score: 1,
        accepted: true,
        tags: ["a"],
        mode: "fast",
        scalar: "x",
      });
      expect(() =>
        schema.decode({
          text: "ok",
          score: 1,
          accepted: true,
          tags: ["a"],
          mode: "medium",
          scalar: "x",
        }),
      ).toThrow();

      expect(schema.jsonSchema).toEqual({
        type: "object",
        properties: {
          text: { type: "string" },
          score: { type: "number" },
          accepted: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["fast", "slow"] },
          scalar: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
        required: ["text", "score", "accepted", "tags", "mode", "scalar"],
        additionalProperties: false,
      });

      const fingerprint = yield* schema.fingerprint;
      expect(fingerprint.startsWith("agent-schema-v1:sha256:")).toBe(true);
      expect(schema.projections.openai).toEqual(schema.projections.canonical);
      expect(schema.projections.anthropic).toEqual(schema.projections.canonical);
      expect(schema.projections.agUi).toEqual(schema.projections.canonical);
      expect(schema.projections.gemini).toEqual({
        type: "object",
        properties: schema.projections.canonical.properties,
        required: schema.projections.canonical.required,
      });
    }),
  );

  it.effect("keeps equivalent schemas fingerprint-identical", () =>
    Effect.gen(function* () {
      const a = defineAgentSchema(
        Schema.Struct({
          alpha: Schema.String,
          beta: Schema.Literal("red", "green", "blue"),
        }),
      );
      const b = defineAgentSchema(
        Schema.Struct({
          beta: Schema.Literal("blue", "green", "red"),
          alpha: Schema.String,
        }),
      );

      expect(yield* a.fingerprint).toBe(yield* b.fingerprint);
    }),
  );

  it.effect("changes fingerprints when schema semantics change", () =>
    Effect.gen(function* () {
      const a = defineAgentSchema(Schema.Struct({ alpha: Schema.String }));
      const b = defineAgentSchema(Schema.Struct({ alpha: Schema.Number }));

      expect(yield* a.fingerprint).not.toBe(yield* b.fingerprint);
    }),
  );

  it("supports string pattern refinements as closed schema semantics", () => {
    const symbolicRefPattern = "^[A-Za-z0-9_.:-]{1,128}$";
    const source = Schema.Struct({
      ref: Schema.String.pipe(Schema.pattern(new RegExp(symbolicRefPattern))),
    });

    expect(inspectAgentSchemaProfile(source)).toEqual([]);

    const schema = defineAgentSchema(source);
    expect(schema.jsonSchema).toEqual({
      type: "object",
      properties: {
        ref: { type: "string", pattern: symbolicRefPattern },
      },
      required: ["ref"],
      additionalProperties: false,
    });
    expect(schema.decode({ ref: "deploy:preview:1" })).toEqual({ ref: "deploy:preview:1" });
    expect(() => schema.decode({ ref: "https://preview.example" })).toThrow();
  });

  it.effect("treats title description and examples as non-semantic annotations", () =>
    Effect.gen(function* () {
      const plain = defineAgentSchema(Schema.Struct({ alpha: Schema.String }));
      const annotated = defineAgentSchema(
        Schema.Struct({
          alpha: Schema.String.annotations({
            title: "Alpha",
            description: "Displayed to humans only",
            examples: ["a"],
          }),
        }),
      );

      expect(yield* annotated.fingerprint).toBe(yield* plain.fingerprint);
      expect(annotated.projections.canonical).toEqual(plain.projections.canonical);
    }),
  );

  it.effect("keeps provider-specific projection differences out of schema fingerprint", () =>
    Effect.gen(function* () {
      const schema = defineAgentSchema(Schema.Struct({ value: Schema.String }));
      const canonicalFingerprint = yield* fingerprintAgentSchema(schema.projections.canonical);
      const geminiFingerprint = yield* fingerprintAgentSchema(schema.projections.canonical);

      expect(schema.projections.gemini).not.toEqual(schema.projections.canonical);
      expect(geminiFingerprint).toBe(canonicalFingerprint);
    }),
  );

  it("rejects unsupported Effect Schema features before boot", () => {
    const unsupported: ReadonlyArray<Schema.Schema.AnyNoContext> = [
      Schema.Struct({ value: Schema.String.pipe(Schema.minLength(1)) }),
      Schema.Struct({
        value: Schema.transform(Schema.String, Schema.Number, {
          decode: (value) => value.length,
          encode: (value) => String(value),
        }),
      }),
      Schema.Struct({ value: Schema.suspend(() => Schema.String) }),
      Schema.Struct({ value: Schema.String.pipe(Schema.brand("NonEmpty")) }),
      Schema.Struct({ value: Schema.optionalWith(Schema.String, { default: () => "x" }) }),
      Schema.Struct({ value: Schema.Literal(1, 2) }),
      Schema.String,
    ];

    for (const schema of unsupported) {
      expect(inspectAgentSchemaProfile(schema).length).toBeGreaterThan(0);
      expect(() => defineAgentSchema(schema)).toThrow(AgentSchemaProfileError);
    }
  });
});
