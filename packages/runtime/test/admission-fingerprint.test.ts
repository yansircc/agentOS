/**
 * Admission — canonical fingerprint contract tests (contract §4.1).
 *
 * Pure-function level. No DO. Validates:
 *   - schema fingerprint stability across calls (sha256 is byte-equal)
 *   - set-semantics arrays (`required`, `enum`) sort before canonicalization
 *   - distinct schemas yield distinct fingerprints
 *   - routeFingerprint is collision-free for distinct routes (Codex P1
 *     regression guard — the FNV-1a aliasing bug)
 *   - opaque route fields are canonicalized but never invented by runtime
 */

import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";

import { makeAdmissionSchemaSpec, routeFingerprint } from "../src/admission";

describe("admission — canonical fingerprint (contract §4.1)", () => {
  const S1 = Schema.Struct({
    summary: Schema.String,
    sentiment: Schema.Literal("positive", "negative", "neutral"),
  });
  const S2 = Schema.Struct({
    summary: Schema.String,
    sentiment: Schema.Literal("positive", "negative", "neutral"),
    keywords: Schema.Array(Schema.String),
  });
  // S3 = S2 with reordered properties AND reordered `required` array.
  // Per §4.1 rule a (sort keys) + rule c' (sort set-semantics arrays),
  // fingerprint MUST equal S2.
  const S3 = Schema.Struct({
    keywords: Schema.Array(Schema.String),
    sentiment: Schema.Literal("neutral", "negative", "positive"),
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

  it("routeFingerprint is deterministic, prefix-tagged, and collision-free for distinct routes", () => {
    const r = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test-endpoint",
      credentialRef: "test-credential",
      modelId: "model-a",
    });
    expect(r.startsWith("route-json-v1:")).toBe(true);
    const r2 = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test-endpoint",
      credentialRef: "test-credential",
      modelId: "model-a",
    });
    expect(r).toBe(r2);
    // Codex P1 regression guard: two different modelIds must produce two
    // different route keys. The previous 32-bit FNV implementation aliased
    // distinct routes onto the same hash, letting a model's unsupported lease
    // short-circuit another model. The canonical-JSON key is collision-free
    // by construction.
    const a = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test-endpoint",
      credentialRef: "test-credential",
      modelId: "model-collision-a",
    });
    const b = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test-endpoint",
      credentialRef: "test-credential",
      modelId: "model-collision-b",
    });
    expect(a).not.toBe(b);
  });

  it("opaque route: runtime does not inject provider defaults", () => {
    const unpinned = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "model-a",
    });
    const explicitVersion = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "model-a",
      wireVersion: "2023-06-01",
    });
    expect(unpinned).not.toBe(explicitVersion);
    expect(unpinned).not.toContain("wireVersion");
  });

  it("opaque route: pinned fields change the fingerprint", () => {
    const unpinned = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "model-a",
    });
    const pinned = routeFingerprint({
      kind: "chat-http",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "model-a",
      wireVersion: "2099-01-01",
    });
    expect(unpinned).not.toBe(pinned);
  });

  it("opaque route: same pinned fields yield equal fingerprint regardless of construction order", () => {
    const a = routeFingerprint({
      wireVersion: "2024-08-01",
      kind: "chat-http",
      endpointRef: "x",
      credentialRef: "Y",
      modelId: "model-a",
    });
    const b = routeFingerprint({
      kind: "chat-http",
      modelId: "model-a",
      endpointRef: "x",
      credentialRef: "Y",
      wireVersion: "2024-08-01",
    });
    expect(a).toBe(b);
  });
});
