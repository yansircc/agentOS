/**
 * Admission — canonical fingerprint contract tests (contract §4.1).
 *
 * Pure-function level. No DO. Validates:
 *   - schema fingerprint stability across calls (sha256 is byte-equal)
 *   - set-semantics arrays (`required`, `enum`) sort before canonicalization
 *   - distinct schemas yield distinct fingerprints
 * Route/wire fingerprints are owned by @agent-os/llm-protocol after provider
 * resolution.
 */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { makeAdmissionSchemaSpec } from "@agent-os/core/runtime-protocol";

describe("admission — canonical fingerprint (contract §4.1)", () => {
  const S1 = Schema.Struct({
    summary: Schema.String,
    sentiment: Schema.Literals(["positive", "negative", "neutral"]),
  });
  const S2 = Schema.Struct({
    summary: Schema.String,
    sentiment: Schema.Literals(["positive", "negative", "neutral"]),
    keywords: Schema.Array(Schema.String),
  });
  // S3 = S2 with reordered properties AND reordered `required` array.
  // Per §4.1 rule a (sort keys) + rule c' (sort set-semantics arrays),
  // fingerprint MUST equal S2.
  const S3 = Schema.Struct({
    keywords: Schema.Array(Schema.String),
    sentiment: Schema.Literals(["neutral", "negative", "positive"]),
    summary: Schema.String,
  });

  it.effect("stability: same schema yields byte-equal fingerprint across calls", () =>
    Effect.gen(function* () {
      const a = yield* makeAdmissionSchemaSpec(S2);
      const b = yield* makeAdmissionSchemaSpec(S2);
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.fingerprint.startsWith("agent-schema-v1:sha256:")).toBe(true);
    }),
  );

  it.effect("set-semantics: S2 == S3 (property + required + enum reorder)", () =>
    Effect.gen(function* () {
      const fS2 = yield* makeAdmissionSchemaSpec(S2);
      const fS3 = yield* makeAdmissionSchemaSpec(S3);
      expect(fS3.fingerprint).toBe(fS2.fingerprint);
    }),
  );

  it.effect("distinction: S1 != S2 (different schemas)", () =>
    Effect.gen(function* () {
      const fS1 = yield* makeAdmissionSchemaSpec(S1);
      const fS2 = yield* makeAdmissionSchemaSpec(S2);
      expect(fS1.fingerprint).not.toBe(fS2.fingerprint);
    }),
  );
});
