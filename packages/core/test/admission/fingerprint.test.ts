/**
 * Admission — canonical fingerprint contract tests (spec-25 §4.1).
 *
 * Pure-function level. No DO. Validates:
 *   - schema fingerprint stability across calls (sha256 is byte-equal)
 *   - set-semantics arrays (`required`, `enum`) sort before canonicalization
 *   - distinct schemas yield distinct fingerprints
 *   - routeFingerprint is collision-free for distinct routes (Codex P1
 *     regression guard — the FNV-1a aliasing bug)
 *   - anthropic-messages: unpinned `anthropicVersion` fills in the
 *     current substrate default before fingerprinting (spec-27 §7)
 */

import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { type JsonSchemaObject, makeSchemaContract, routeFingerprint } from "../../src/admission";

describe("admission — canonical fingerprint (spec-25 §4.1)", () => {
  const S1: JsonSchemaObject = {
    type: "object",
    properties: {
      summary: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
    },
    required: ["summary", "sentiment"],
  };
  const S2: JsonSchemaObject = {
    type: "object",
    properties: {
      summary: { type: "string" },
      sentiment: { type: "string", enum: ["positive", "negative", "neutral"] },
      keywords: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "sentiment", "keywords"],
  };
  // S3 = S2 with reordered properties AND reordered `required` array.
  // Per §4.1 rule a (sort keys) + rule c' (sort set-semantics arrays),
  // fingerprint MUST equal S2.
  const S3: JsonSchemaObject = {
    type: "object",
    properties: {
      keywords: { type: "array", items: { type: "string" } },
      sentiment: { type: "string", enum: ["neutral", "negative", "positive"] },
      summary: { type: "string" },
    },
    required: ["keywords", "sentiment", "summary"],
  };

  it("stability: same schema yields byte-equal fingerprint across calls", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* makeSchemaContract(S2);
        const b = yield* makeSchemaContract(S2);
        expect(a.fingerprint).toBe(b.fingerprint);
        expect(a.fingerprint.startsWith("effect-json-schema-v1:sha256:")).toBe(true);
      }),
    ));

  it("set-semantics: S2 == S3 (property + required + enum reorder)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fS2 = yield* makeSchemaContract(S2);
        const fS3 = yield* makeSchemaContract(S3);
        expect(fS3.fingerprint).toBe(fS2.fingerprint);
      }),
    ));

  it("distinction: S1 != S2 (different schemas)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fS1 = yield* makeSchemaContract(S1);
        const fS2 = yield* makeSchemaContract(S2);
        expect(fS1.fingerprint).not.toBe(fS2.fingerprint);
      }),
    ));

  it("routeFingerprint is deterministic, prefix-tagged, and collision-free for distinct routes", () => {
    const r = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/x/y" });
    expect(r.startsWith("route-json-v1:")).toBe(true);
    const r2 = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/x/y" });
    expect(r).toBe(r2);
    // Codex P1 regression guard: two different modelIds must produce two
    // different route keys. The previous 32-bit FNV implementation aliased
    // distinct routes onto the same hash (e.g. `@cf/3hwlz7pq9l` and
    // `@cf/x3qxkshczh` collided), letting a model's unsupported lease
    // short-circuit another model. The canonical-JSON key is collision-free
    // by construction.
    const a = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/3hwlz7pq9l" });
    const b = routeFingerprint({ kind: "cf-ai-binding", modelId: "@cf/x3qxkshczh" });
    expect(a).not.toBe(b);
  });

  // ── Codex regression 2026-05-26: anthropic-messages route default
  //    must enter the fingerprint. `anthropicVersion` is part of the
  //    wire surface (different version = different feature set + error
  //    semantics), so capability evidence keyed without it would roll
  //    forward incorrectly when the substrate later bumps its default.
  //    Normalization injects the current default before canonical JSON,
  //    making bumps invalidate unpinned-route leases by construction.
  it("anthropic route: unpinned routeFingerprint matches explicit current default", () => {
    const unpinned = routeFingerprint({
      kind: "anthropic-messages",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "claude-sonnet-4-6",
    });
    const explicitDefault = routeFingerprint({
      kind: "anthropic-messages",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "claude-sonnet-4-6",
      anthropicVersion: "2023-06-01",
    });
    expect(unpinned).toBe(explicitDefault);
    // and the canonical JSON actually contains the version field
    expect(unpinned).toContain('"anthropicVersion":"2023-06-01"');
  });

  it("anthropic route: pinned version yields a fingerprint distinct from default", () => {
    const unpinned = routeFingerprint({
      kind: "anthropic-messages",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "claude-sonnet-4-6",
    });
    const pinnedFuture = routeFingerprint({
      kind: "anthropic-messages",
      endpointRef: "test",
      credentialRef: "K",
      modelId: "claude-sonnet-4-6",
      anthropicVersion: "2099-01-01",
    });
    expect(unpinned).not.toBe(pinnedFuture);
  });

  it("anthropic route: same pinned version yields equal fingerprint regardless of construction order", () => {
    const a = routeFingerprint({
      anthropicVersion: "2024-08-01",
      kind: "anthropic-messages",
      endpointRef: "x",
      credentialRef: "Y",
      modelId: "claude-haiku",
    });
    const b = routeFingerprint({
      kind: "anthropic-messages",
      modelId: "claude-haiku",
      endpointRef: "x",
      credentialRef: "Y",
      anthropicVersion: "2024-08-01",
    });
    expect(a).toBe(b);
  });
});
