import { Effect, Schema, SchemaGetter } from "effect";
import { describe, expect, it } from "@effect/vitest";

import {
  AgentSchemaProfileError,
  defineAgentSchema,
  fingerprintAgentSchema,
  inspectAgentSchemaProfile,
  type AgentSchemaDecoder,
} from "../../src/agent-schema";

describe("AgentSchema profile spike", () => {
  it.effect("decodes, fingerprints, and projects the supported fixture matrix", () =>
    Effect.gen(function* () {
      const schema = defineAgentSchema(
        Schema.Struct({
          text: Schema.String,
          score: Schema.Number,
          accepted: Schema.Boolean,
          tags: Schema.Array(Schema.String),
          mode: Schema.Literals(["fast", "slow"]),
          scalar: Schema.Union([Schema.String, Schema.Number]),
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
      expect(schema.projections.canonical).toEqual(schema.jsonSchema);
    }),
  );

  it.effect("keeps equivalent schemas fingerprint-identical", () =>
    Effect.gen(function* () {
      const a = defineAgentSchema(
        Schema.Struct({
          alpha: Schema.String,
          beta: Schema.Literals(["red", "green", "blue"]),
        }),
      );
      const b = defineAgentSchema(
        Schema.Struct({
          beta: Schema.Literals(["blue", "green", "red"]),
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
      ref: Schema.String.pipe(Schema.check(Schema.isPattern(new RegExp(symbolicRefPattern)))),
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

  it("supports bounded string refinements as closed schema semantics", () => {
    const source = Schema.Struct({
      content: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(8)),
      ),
    });

    expect(inspectAgentSchemaProfile(source)).toEqual([]);

    const schema = defineAgentSchema(source);
    expect(schema.jsonSchema).toEqual({
      type: "object",
      properties: {
        content: { type: "string", minLength: 1, maxLength: 8 },
      },
      required: ["content"],
      additionalProperties: false,
    });
    expect(schema.decode({ content: "chunk" })).toEqual({ content: "chunk" });
    expect(() => schema.decode({ content: "" })).toThrow("minLength");
    expect(() => schema.decode({ content: "too-long-content" })).toThrow("maxLength");
  });

  it.effect("treats title description and examples as non-semantic annotations", () =>
    Effect.gen(function* () {
      const plain = defineAgentSchema(Schema.Struct({ alpha: Schema.String }));
      const annotated = defineAgentSchema(
        Schema.Struct({
          alpha: Schema.String.annotate({
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

  it.effect("fingerprints canonical schema projections", () =>
    Effect.gen(function* () {
      const schema = defineAgentSchema(Schema.Struct({ value: Schema.String }));
      const canonicalFingerprint = yield* fingerprintAgentSchema(schema.projections.canonical);

      expect(canonicalFingerprint).toBe(yield* schema.fingerprint);
    }),
  );

  it("rejects unsupported Effect Schema features before boot", () => {
    const unsupported: ReadonlyArray<AgentSchemaDecoder<unknown>> = [
      Schema.Struct({
        value: Schema.String.pipe(
          Schema.decodeTo(Schema.Number, {
            decode: SchemaGetter.transform((value) => value.length),
            encode: SchemaGetter.transform((value) => String(value)),
          }),
        ),
      }),
      Schema.Struct({ value: Schema.suspend(() => Schema.String) }),
      Schema.Struct({ value: Schema.String.pipe(Schema.brand("NonEmpty")) }),
      Schema.Struct({
        value: Schema.String.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("x"))),
      }),
      Schema.Struct({ value: Schema.Literals([1, 2]) }),
      Schema.String,
    ];

    for (const schema of unsupported) {
      expect(inspectAgentSchemaProfile(schema).length).toBeGreaterThan(0);
      expect(() => defineAgentSchema(schema)).toThrow(AgentSchemaProfileError);
    }
  });
});
