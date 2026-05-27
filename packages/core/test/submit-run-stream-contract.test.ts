/**
 * submitRunStream — composition bridge contract.
 *
 * The bridge turns one submit invocation into run-stream SSE frames. It does
 * not write ledger events; durable truth stays in the submit-owned ledger rows.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { decodeRunStreamData, projectRunStream, type RunStreamFrame } from "@agent-os/run-stream";

import type { LedgerEventRpc, SubmitRunStreamSpec } from "../src";
import { defineRegisteredTool, permissiveToolAdmitter } from "../src/tools";
import type { SubmitStreamTestDO } from "./test-worker";

interface TestEnv {
  readonly SUBMIT_STREAM_DO: DurableObjectNamespace<SubmitStreamTestDO>;
}

interface SubmitStreamRpc {
  readonly emitEvent: (spec: {
    readonly event: string;
    readonly data: unknown;
  }) => Promise<{ id: number }>;
  readonly events: () => Promise<ReadonlyArray<LedgerEventRpc>>;
  readonly submitRunStream: (spec: SubmitRunStreamSpec) => Promise<Response>;
}

const testEnv = env as unknown as TestEnv;

const stubFor = (scope: string): SubmitStreamRpc =>
  testEnv.SUBMIT_STREAM_DO.get(
    testEnv.SUBMIT_STREAM_DO.idFromName(scope),
  ) as unknown as SubmitStreamRpc;

const baseSpec = (event = "stream.done"): SubmitRunStreamSpec => ({
  intent: "Return a final answer.",
  context: { source: "submit-run-stream-test" },
  route: { kind: "cf-ai-binding", modelId: "@cf/stub/test" },
  tools: {},
  budget: { maxTurns: 1 },
  deliver: { event },
});

const readRunStreamFrames = async (response: Response): Promise<ReadonlyArray<RunStreamFrame>> => {
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const data = raw
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      const frame = data === undefined ? null : decodeRunStreamData(data);
      expect(frame).not.toBeNull();
      return frame as RunStreamFrame;
    });
};

describe("submitRunStream — run-stream composition bridge", () => {
  it("emits submit-owned ledger frames and the terminal submit result", async () => {
    const stub = stubFor("thread/submit-run-stream-success");

    const frames = await readRunStreamFrames(await stub.submitRunStream(baseSpec()));
    const projection = projectRunStream(frames);

    expect(projection.status).toBe("succeeded");
    expect(projection.result).toEqual({
      ok: true,
      runId: 1,
      final: "stream done",
      eventCount: 5,
      tokensUsed: 15,
    });
    expect(projection.ledgerEvents.map((event) => event.kind)).toEqual([
      "agent.run.started",
      "chat.ingested",
      "llm.response",
      "stream.done",
      "agent.run.completed",
    ]);
  });

  it("does not write any ledger row beyond submit's own facts", async () => {
    const stub = stubFor("thread/submit-run-stream-no-shadow-truth");
    await stub.emitEvent({ event: "seed.before", data: {} });

    const frames = await readRunStreamFrames(await stub.submitRunStream(baseSpec()));
    const ledgerFrames = frames.filter((frame) => frame.kind === "ledger_event");
    const events = await stub.events();

    expect(events.map((event) => event.kind)).toEqual([
      "seed.before",
      "agent.run.started",
      "chat.ingested",
      "llm.response",
      "stream.done",
      "agent.run.completed",
    ]);
    expect(ledgerFrames.map((frame) => frame.event.kind)).toEqual([
      "agent.run.started",
      "chat.ingested",
      "llm.response",
      "stream.done",
      "agent.run.completed",
    ]);
  });

  it("emits failed submit results as terminal submit_result frames", async () => {
    const stub = stubFor("thread/submit-run-stream-failed-submit");
    const invalidCompositionTool = defineRegisteredTool({
      definition: {
        type: "function",
        function: {
          name: "lookup",
          description: "Unused by this failure path",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
      execute: async () => ({ value: 1 }),
      authorityClass: "read",
      admit: permissiveToolAdmitter,
    });

    const frames = await readRunStreamFrames(
      await stub.submitRunStream({
        ...baseSpec("structured.done"),
        tools: { lookup: invalidCompositionTool },
        outputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
      }),
    );
    const projection = projectRunStream(frames);

    expect(projection.status).toBe("failed");
    expect(projection.result).toEqual({
      ok: false,
      runId: 1,
      reason: "upstream_failure",
      eventCount: 3,
      tokensUsed: 0,
    });
    expect(projection.ledgerEvents.map((event) => event.kind)).toEqual([
      "agent.run.started",
      "chat.ingested",
      "agent.aborted.upstream_failure",
    ]);
  });

  it("does not require token delta frames", async () => {
    const stub = stubFor("thread/submit-run-stream-without-turn-deltas");
    const frames = await readRunStreamFrames(await stub.submitRunStream(baseSpec()));

    expect(frames.some((frame) => frame.kind === "turn_frame")).toBe(false);
    expect(projectRunStream(frames).turnStreams).toEqual({});
  });
});
