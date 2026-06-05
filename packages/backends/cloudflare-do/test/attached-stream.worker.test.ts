import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  decodeAttachedStreamMessage,
  type AttachedStreamOutboundFrame,
} from "@agent-os/attached-stream";
import type { BackendProtocolTruthIdentity } from "@agent-os/backend-protocol";
import type { AgentAttachedStreamCancelSpec, AgentAttachedStreamSpec } from "../src";
import type { AttachedStreamTestDO } from "./test-worker";
import { testTruthIdentity } from "./_identity";

interface TestEnv {
  readonly ATTACHED_STREAM_DO: DurableObjectNamespace<AttachedStreamTestDO>;
}

interface AttachedStreamRpc {
  readonly attachStream: (spec: AgentAttachedStreamSpec) => Promise<Response>;
  readonly cancelStream: (
    spec: AgentAttachedStreamCancelSpec,
  ) => Promise<{ readonly status: string }>;
  readonly events: (
    identity: BackendProtocolTruthIdentity,
  ) => Promise<ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>>;
}

const testEnv = env as unknown as TestEnv;

const withAttachedDO = <A>(
  scope: string,
  f: (instance: AttachedStreamRpc, identity: BackendProtocolTruthIdentity) => Promise<A>,
): Promise<A> => {
  const stub = testEnv.ATTACHED_STREAM_DO.get(testEnv.ATTACHED_STREAM_DO.idFromName(scope));
  return runInDurableObject(stub, (instance) =>
    f(instance as unknown as AttachedStreamRpc, testTruthIdentity(scope)),
  );
};

const nextMessage = (socket: WebSocket): Promise<AttachedStreamOutboundFrame> =>
  new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      socket.removeEventListener("message", onMessage);
      const frame = typeof event.data === "string" ? decodeAttachedStreamMessage(event.data) : null;
      if (frame === null || frame.kind === "input" || frame.kind === "cancel") {
        reject(new Error("unexpected websocket frame"));
        return;
      }
      resolve(frame);
    };
    socket.addEventListener("message", onMessage);
  });

const parseSseFrames = (chunk: string): ReadonlyArray<AttachedStreamOutboundFrame> =>
  chunk
    .split("\n\n")
    .filter((raw) => raw.includes("data: "))
    .map((raw) => {
      const data = raw
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      const frame = data === undefined ? null : decodeAttachedStreamMessage(data);
      if (frame === null || frame.kind === "input" || frame.kind === "cancel") {
        throw new Error("unexpected SSE frame");
      }
      return frame;
    });

const readSseFrames = async (
  response: Response,
  count: number,
): Promise<ReadonlyArray<AttachedStreamOutboundFrame>> => {
  if (response.body === null) throw new Error("missing SSE body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    return await readSseFramesFromReader(reader, decoder, count);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
};

const readSseFramesFromReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  count: number,
): Promise<ReadonlyArray<AttachedStreamOutboundFrame>> => {
  const frames: AttachedStreamOutboundFrame[] = [];
  while (frames.length < count) {
    const read = await reader.read();
    if (read.done) break;
    frames.push(...parseSseFrames(decoder.decode(read.value, { stream: true })));
  }
  return frames.slice(0, count);
};

describe("attached stream Cloudflare DO surface", () => {
  it("runs a bidi WebSocket attached stream and commits terminal facts", async () => {
    await withAttachedDO("attached-ws", async (stub, identity) => {
      const response = await stub.attachStream({
        kind: "test.attached_echo",
        payload: { test: true },
      });
      const socket = response.webSocket;
      if (socket === null) throw new Error("missing websocket");
      socket.accept();

      const opened = await nextMessage(socket);
      expect(opened).toMatchObject({ kind: "opened", mode: "bidi", seq: 0 });
      socket.send(
        JSON.stringify({
          kind: "input",
          streamRef: opened.streamRef,
          seq: 0,
          payload: "hello",
        }),
      );

      await expect(nextMessage(socket)).resolves.toMatchObject({
        kind: "output",
        channel: "stdout",
        payload: "hello",
      });
      await expect(nextMessage(socket)).resolves.toMatchObject({
        kind: "completed",
        terminal: { echoed: "hello" },
      });
      const events = await stub.events(identity);
      expect(events.map((event) => event.kind)).toEqual(["test.attached_echo.completed"]);
      socket.close();
    });
  });

  it("runs an output-only SSE attached stream", async () => {
    await withAttachedDO("attached-sse", async (stub, identity) => {
      const response = await stub.attachStream({
        kind: "test.attached_output",
        payload: { label: "one" },
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const frames = await readSseFrames(response, 3);
      expect(frames.map((frame) => frame.kind)).toEqual(["opened", "progress", "completed"]);
      const events = await stub.events(identity);
      expect(events.map((event) => event.kind)).toEqual(["test.attached_output.completed"]);
    });
  });

  it("cancels output-only streams explicitly; reader cancel only detaches", async () => {
    await withAttachedDO("attached-cancel", async (stub, identity) => {
      const response = await stub.attachStream({
        kind: "test.attached_cancellable",
        payload: {},
      });
      if (response.body === null) throw new Error("missing SSE body");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const [opened] = await readSseFramesFromReader(reader, decoder, 1);
      const cancel = await stub.cancelStream({
        streamRef: opened?.streamRef ?? "",
        reason: "user",
      });
      expect(cancel).toEqual({ status: "requested" });
      await scheduler.wait(10);
      const events = await stub.events(identity);
      expect(events.map((event) => event.kind)).toEqual(["test.attached_cancellable.cancelled"]);
      await reader.cancel().catch(() => undefined);
    });

    await withAttachedDO("attached-detach", async (stub, identity) => {
      const response = await stub.attachStream({
        kind: "test.attached_cancellable",
        payload: {},
      });
      if (response.body === null) throw new Error("missing SSE body");
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
      await scheduler.wait(10);
      const events = await stub.events(identity);
      expect(events).toEqual([]);
    });
  });
});
