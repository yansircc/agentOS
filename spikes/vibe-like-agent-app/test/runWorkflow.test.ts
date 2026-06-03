import { describe, expect, it } from "@effect/vitest";
import { runFakeLocalLoop } from "../src/runWorkflow";

describe("vibe-like spike runWorkflow", () => {
  it("runs prompt -> frame -> terminal fact -> projection read", async () => {
    const result = await runFakeLocalLoop("write a tiny weather tool");

    expect(result.runId).toMatch(/^run-/);
    expect(result.frame).toMatchObject({
      kind: "output",
      channel: "assistant",
    });
    expect(result.state).toMatchObject({
      runId: result.runId,
      status: "completed",
    });
    expect(result.firstFrameLatencyMs).toBeLessThan(2_000);
    expect(result.projectionLatencyMs).toBeLessThan(500);
  });
});
