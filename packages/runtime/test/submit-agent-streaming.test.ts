import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { LlmStreamFrame } from "@agent-os/core/llm-protocol";
import { UpstreamFailure } from "@agent-os/core/errors";
import { decodeRuntimeLedgerEvent, RUNTIME_EVENT_KIND } from "@agent-os/core/runtime-protocol";
import {
  encodeSubmitLiveFrame,
  SUBMIT_LIVE_MAX_FRAME_BYTES,
  SubmitLiveFrameError,
} from "../src/submit-live";
import { baseSpec, response, runSubmit } from "./_submit-agent-harness";

describe("submit-agent live LLM projection", () => {
  it.effect("observes ordered deltas while only the terminal response enters the ledger", () =>
    Effect.gen(function* () {
      const observed: Array<{ readonly turn: number; readonly frame: LlmStreamFrame }> = [];
      const run = yield* runSubmit(
        baseSpec(),
        [response({ items: [{ type: "message", text: "live answer" }] })],
        {
          onLlmFrame: (turn, frame) =>
            Effect.sync(() => {
              observed.push({ turn: turn.index, frame });
            }),
        },
      );

      expect(run.result.ok).toBe(true);
      expect(observed.map(({ frame }) => frame.sequence)).toEqual([0, 1, 2, 3]);
      expect(observed.map(({ frame }) => frame.kind)).toEqual([
        "delta",
        "delta",
        "delta",
        "terminal",
      ]);
      expect(observed.every(({ turn }) => turn === 0)).toBe(true);

      const runtimeKinds = run.events.flatMap((event) => {
        const decoded = decodeRuntimeLedgerEvent(event);
        return decoded._tag === "runtime" ? [decoded.event.kind] : [];
      });
      expect(runtimeKinds.filter((kind) => kind === RUNTIME_EVENT_KIND.LLM_RESPONSE)).toHaveLength(
        1,
      );
      expect(runtimeKinds.some((kind) => kind.includes("delta") || kind.includes("stream"))).toBe(
        false,
      );
    }),
  );

  it.effect("fails closed when the ephemeral observer rejects a delta", () =>
    Effect.gen(function* () {
      const run = yield* runSubmit(
        baseSpec(),
        [response({ items: [{ type: "message", text: "must not commit" }] })],
        {
          onLlmFrame: () =>
            Effect.fail(new UpstreamFailure({ cause: "test_live_observer_disconnected" })),
        },
      );
      expect(run.result.ok).toBe(false);
      expect(
        run.events.some((event) => {
          const decoded = decodeRuntimeLedgerEvent(event);
          return (
            decoded._tag === "runtime" && decoded.event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE
          );
        }),
      ).toBe(false);
    }),
  );

  it.effect("rejects an encoded live frame above the fixed byte bound", () =>
    Effect.gen(function* () {
      const encoded = yield* Effect.result(
        encodeSubmitLiveFrame({
          kind: "llm",
          turn: { id: 1, index: 0 },
          frame: {
            sequence: 0,
            kind: "delta",
            delta: { type: "text_delta", id: "text-0", text: "x".repeat(70_000) },
          },
        }),
      );
      expect(encoded._tag).toBe("Failure");
      if (encoded._tag === "Failure") {
        expect(encoded.failure).toBeInstanceOf(SubmitLiveFrameError);
        expect(encoded.failure.reason).toBe("frame_too_large");
        expect(encoded.failure.bytes).toBeGreaterThan(SUBMIT_LIVE_MAX_FRAME_BYTES);
      }
    }),
  );
});
