import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {} from "@effect/vitest";
import { decodeSubmitLiveFrame } from "@agent-os/runtime";
import type { FacadeSubmitTestDO } from "./test-worker";

interface TestEnv {
  readonly FACADE_SUBMIT_DO: DurableObjectNamespace<FacadeSubmitTestDO>;
}

const testEnv = env as unknown as TestEnv;

describe("Cloudflare submitLive", () => {
  it("streams the same ordered envelope as the Node host", async () => {
    const scope = "cloudflare-live-stream";
    const stub = testEnv.FACADE_SUBMIT_DO.get(testEnv.FACADE_SUBMIT_DO.idFromName(scope));
    const response = await runInDurableObject(stub, (instance) =>
      instance.submitLive({
        intent: "lookup",
        input: { key: "abc" },
        context: { source: "cloudflare-live" },
        budget: { maxTurns: 1 },
      }),
    );
    const text = await response.text();
    const frames = text
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => decodeSubmitLiveFrame(JSON.parse(block.slice("data: ".length))))
      .filter((frame) => frame !== null);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(frames.at(-1)?.kind).toBe("result");
    const llmFrames = frames.flatMap((frame) => (frame?.kind === "llm" ? [frame] : []));
    expect(llmFrames.map(({ frame }) => frame.sequence)).toEqual([0, 1, 2, 3]);
    expect(llmFrames.at(-1)?.frame.kind).toBe("terminal");
  });
});
