import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createLocalAgentRuntime } from "@agent-os/runtime/local";
import { decodeSubmitLiveFrame } from "@agent-os/runtime";

const decodeSse = (text: string) =>
  text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => decodeSubmitLiveFrame(JSON.parse(block.slice("data: ".length))))
    .filter((frame) => frame !== null);

describe("Node submitLive", () => {
  it.effect("streams invocation-coupled frames and one final result", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.tryPromise(() =>
        createLocalAgentRuntime({
          identity: "node-live-stream",
          cwd: process.cwd(),
          llm: {
            kind: "test",
            responses: [
              {
                items: [{ type: "message", text: "node live" }],
                usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
              },
            ],
          },
        }),
      );
      const response = yield* Effect.tryPromise(() =>
        runtime.submitLive({ intent: "answer", context: {} }),
      );
      const frames = decodeSse(yield* Effect.tryPromise(() => response.text()));

      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(frames.at(-1)?.kind).toBe("result");
      const llmFrames = frames.flatMap((frame) => (frame?.kind === "llm" ? [frame] : []));
      expect(llmFrames.map(({ frame }) => frame.sequence)).toEqual([0, 1, 2, 3]);
      expect(llmFrames.at(-1)?.frame.kind).toBe("terminal");
      expect(runtime.events().some((event) => event.kind.includes("delta"))).toBe(false);
    }),
  );

  it.effect("cancels the active submit scope when the response body disconnects", () =>
    Effect.gen(function* () {
      const runtime = yield* Effect.tryPromise(() =>
        createLocalAgentRuntime({
          identity: "node-live-disconnect",
          cwd: process.cwd(),
          llm: {
            kind: "test",
            responses: [
              {
                items: [{ type: "message", text: "must not settle" }],
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              },
            ],
          },
        }),
      );
      const response = yield* Effect.tryPromise(() =>
        runtime.submitLive({ intent: "disconnect", context: {} }),
      );
      yield* Effect.sync(() => {
        void response.body!.cancel("test disconnect");
      });
      yield* Effect.forEach([0, 1, 2, 3], () => Effect.yieldNow);

      expect(runtime.events().some((event) => event.kind === "llm.response")).toBe(false);
    }),
  );
});
