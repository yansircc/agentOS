import { describe, expect, it, vi } from "vite-plus/test";
import type { SubmitResult, SubmitSpec } from "@agent-os/runtime-protocol";
import {
  createAttachedStreamSseResponse,
  createBatchedSubmitRunStreamResponse,
  createSseHttpResponse,
  createSseHttpTextResponse,
  SSE_HTTP_CONTENT_TYPE,
} from "../src";
import { decodeRunStreamData, projectRunStream, type LedgerEventRpc } from "@agent-os/run-stream";
import type { AttachedStreamOutboundFrame } from "@agent-os/attached-stream";

const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});

const ledgerEvent = (id: number, kind = "agent.run.completed"): LedgerEventRpc => ({
  id,
  ts: 1_700_000_000_000 + id,
  kind,
  ...eventIdentity("session/sse-http"),
  payload: { id },
});

const okResult: SubmitResult = {
  ok: true,
  status: "delivered",
  runId: 1,
  final: "done",
  eventCount: 2,
  tokensUsed: 3,
};

const submitSpec: SubmitSpec = {
  intent: "Return a final answer.",
  context: { source: "sse-http-test" },
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "test-endpoint",
    credentialRef: "test-credential",
    modelId: "test-model",
  },
  tools: {},
  budget: { maxTurns: 1 },
  effectAuthorityRef: { authorityClass: "llm_route", authorityId: "sse-http-test" },
};

const frameDataFromSse = (text: string) =>
  text
    .split("\n\n")
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const data = raw
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      const frame = data === undefined ? null : decodeRunStreamData(data);
      expect(frame).not.toBeNull();
      return frame!;
    });

describe("@agent-os/sse-http", () => {
  it("creates a Web Fetch SSE response from encoded chunks", async () => {
    const response = createSseHttpResponse(["event: one\ndata: 1\n\n"]);
    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toBe("event: one\ndata: 1\n\n");
  });

  it("runs cancel hooks when the response body is cancelled", async () => {
    const onCancel = vi.fn();
    async function* source(): AsyncGenerator<string> {
      yield "event: one\ndata: 1\n\n";
      await new Promise<void>(() => undefined);
    }
    const response = createSseHttpResponse(source(), { onCancel });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("creates a text SSE response without a stream lifecycle", async () => {
    const response = createSseHttpTextResponse("event: ready\ndata: {}\n\n");
    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    expect(await response.text()).toBe("event: ready\ndata: {}\n\n");
  });

  it("creates a batched submit run stream response without composer host wrappers", async () => {
    const response = await createBatchedSubmitRunStreamResponse({
      submitSpec,
      afterId: 0,
      events: async () => [ledgerEvent(1)],
      submit: async () => okResult,
    });

    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    const projection = projectRunStream(frameDataFromSse(await response.text()));
    expect(projection.turnStreams).toEqual({});
    expect(projection.status).toBe("succeeded");
    expect(projection.result).toEqual(okResult);
  });

  it("wraps attached-stream output frames as SSE-over-HTTP", async () => {
    async function* output(): AsyncGenerator<AttachedStreamOutboundFrame> {
      yield {
        kind: "opened",
        streamRef: "attached/test",
        seq: 0,
        mode: "output_only",
      };
      yield {
        kind: "output",
        streamRef: "attached/test",
        seq: 1,
        channel: "stdout",
        payload: "hello",
      };
    }

    const response = createAttachedStreamSseResponse(output());
    expect(response.headers.get("content-type")).toBe(SSE_HTTP_CONTENT_TYPE);
    expect(await response.text()).toContain("event: opened");
    expect(await createAttachedStreamSseResponse(output()).text()).toContain("event: output");
  });
});
