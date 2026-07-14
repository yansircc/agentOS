import { Effect, Result } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { JsonStringifyError } from "@agent-os/core/errors";
import {
  canonicalSerializablePayload,
  canonicalSerializablePayloadResult,
  canonicalSerializablePayloadSync,
} from "../../src/in-memory/state-helpers";
import { createInMemoryBackendState } from "../../src/in-memory/state";
import { runtimeEventIdentity, truthIdentity } from "./identity";

const expectJsonStringifyFailure = (result: Result.Result<unknown, unknown>): void => {
  expect(Result.isFailure(result)).toBe(true);
  expect(Result.isFailure(result) ? result.failure : undefined).toBeInstanceOf(JsonStringifyError);
};

const circularPayload = (): { self?: unknown } => {
  const payload: { self?: unknown } = {};
  payload.self = payload;
  return payload;
};

describe("in-memory canonical payload codec", () => {
  it.effect("derives lazy Effect and synchronous projections from one canonical result", () =>
    Effect.gen(function* () {
      let encodes = 0;
      const payload = {
        visible: "raw",
        toJSON: () => {
          encodes += 1;
          return { visible: "stored" };
        },
      };
      Object.defineProperty(payload, "secret", {
        value: "not-recorded",
        enumerable: false,
      });

      const effect = canonicalSerializablePayload(payload);
      expect(encodes).toBe(0);

      const result = canonicalSerializablePayloadResult(payload);
      expect(Result.isSuccess(result) ? result.success : undefined).toEqual({
        visible: "stored",
      });
      expect(canonicalSerializablePayloadSync(payload)).toEqual({ visible: "stored" });
      expect(yield* effect).toEqual({ visible: "stored" });
      expect(encodes).toBe(3);
    }),
  );

  it.effect("maps thrown JSON serialization failures across both projections", () =>
    Effect.gen(function* () {
      const payload = circularPayload();

      expectJsonStringifyFailure(canonicalSerializablePayloadResult(payload));
      expect(() => canonicalSerializablePayloadSync(payload)).toThrow(JsonStringifyError);
      expectJsonStringifyFailure(yield* Effect.result(canonicalSerializablePayload(payload)));
    }),
  );

  it.effect("rejects a non-string JSON serialization result", () =>
    Effect.gen(function* () {
      const result = canonicalSerializablePayloadResult(undefined);
      expectJsonStringifyFailure(result);
      expect(Result.isFailure(result) ? result.failure.cause : undefined).toBe(
        "ledger event payload must be JSON serializable",
      );
      expect(() => canonicalSerializablePayloadSync(undefined)).toThrow(JsonStringifyError);
      expectJsonStringifyFailure(yield* Effect.result(canonicalSerializablePayload(undefined)));
    }),
  );

  it.effect("rolls back staged transaction events when synchronous serialization fails", () =>
    Effect.gen(function* () {
      const scope = "canonical-codec-rollback";
      const state = createInMemoryBackendState();
      const failed = yield* Effect.result(
        state.commitAttachedStreamTerminal(
          runtimeEventIdentity(scope),
          scope,
          "stream:failed",
          "test.canonical_codec",
          10,
          new AbortController().signal,
          { kind: "completed", terminal: { ok: true } },
          (_terminal, tx) => {
            tx.insertEvent({ kind: "test.canonical_codec.first", payload: { ok: true } });
            tx.insertEvent({ kind: "test.canonical_codec.invalid", payload: circularPayload() });
            return null;
          },
        ),
      );

      expectJsonStringifyFailure(failed);
      expect(state.snapshot(truthIdentity(scope))).toEqual([]);

      const committed = yield* state.commitAttachedStreamTerminal(
        runtimeEventIdentity(scope),
        scope,
        "stream:succeeded",
        "test.canonical_codec",
        11,
        new AbortController().signal,
        { kind: "completed", terminal: { ok: true } },
        (_terminal, tx) => {
          tx.insertEvent({ kind: "test.canonical_codec.succeeded", payload: { ok: true } });
          return null;
        },
      );
      expect(committed.events.map((event) => event.id)).toEqual([1]);
      expect(state.snapshot(truthIdentity(scope)).map((event) => event.id)).toEqual([1]);
    }),
  );
});
