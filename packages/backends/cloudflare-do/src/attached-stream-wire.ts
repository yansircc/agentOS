import {
  decodeAttachedStreamMessage,
  encodeAttachedStreamMessage,
  isAttachedStreamInboundFrame,
} from "@agent-os/attached-stream";
import type { AttachedStreamSession } from "@agent-os/runtime";
import { createAttachedStreamSseResponse } from "@agent-os/sse-http";
import type { Effect as EffectType } from "effect";

type AttachedStreamEffectRunner = <A, E>(effect: EffectType.Effect<A, E>) => Promise<A>;

const attachedStreamWebSocketResponse = (
  session: AttachedStreamSession,
  runEffect: AttachedStreamEffectRunner,
): Response => {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  const detach = (): void => {
    void runEffect(session.detach()).catch(() => undefined);
  };

  server.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const frame = decodeAttachedStreamMessage(event.data);
    if (!isAttachedStreamInboundFrame(frame)) return;
    void runEffect(session.send(frame)).catch(() => undefined);
  });
  server.addEventListener("close", detach);
  server.addEventListener("error", detach);

  void (async () => {
    try {
      for await (const frame of session.output) {
        server.send(encodeAttachedStreamMessage(frame));
      }
      server.close(1000, "attached stream closed");
    } catch (cause) {
      try {
        server.close(1011, String(cause));
      } catch {
        // The peer may have already closed the socket.
      }
    }
  })();

  return new Response(null, { status: 101, webSocket: client });
};

export const createAttachedStreamResponse = (
  session: AttachedStreamSession,
  runEffect: AttachedStreamEffectRunner,
): Response =>
  session.mode === "bidi"
    ? attachedStreamWebSocketResponse(session, runEffect)
    : createAttachedStreamSseResponse(session.output, {
        onCancel: () => runEffect(session.detach()),
      });
