/**
 * Server-Sent Events stream for ledger reads — the SSE surface of
 * `AgentDOBase.streamEvents`. Extracted from agent-do.ts as a pure
 * helper so the DO façade can stay a thin RPC layer.
 *
 * Algorithm (snapshot → live handoff):
 *
 *   1. Subscribe to EventBus in `buffering` mode — live events that
 *      arrive while we read the snapshot land in `liveQueue`.
 *   2. Drain the ledger snapshot from `afterId` forward, enqueueing
 *      each row as an SSE `event: ledger`. Update the watermark.
 *   3. Flush the buffered live events that are strictly after the
 *      watermark; flip the subscription to `live` mode so subsequent
 *      bus events enqueue directly.
 *   4. Heartbeat (`: keepalive\n\n`) at `heartbeatMs` keeps proxies
 *      from idling out the connection.
 *
 * The single watermark guarantees no gap, no duplicate across the
 * handoff: snapshot rows always win for ids ≤ watermark, live events
 * for ids > watermark.
 *
 * Wire is closed:
 *   id: <ledger.id>
 *   event: ledger
 *   data: <LedgerEventRpc JSON>
 *
 * Reconnect cursor is `afterId`; HTTP `Last-Event-ID` parsing belongs
 * to the Worker fetch handler / app layer, not this module.
 */

import { Effect, type ManagedRuntime } from "effect";

import type { LedgerEvent, StreamEventsOptions } from "../types";
import { EventBus } from "./event-bus";
import { Ledger, eventToRpc } from "./ledger";

const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;

const normalizePositiveInteger = (value: number | undefined, fallback: number): number =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

const normalizeKinds = (
  kinds: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined => {
  if (kinds === undefined) return undefined;
  const normalized = Array.from(new Set(kinds)).filter((kind) => kind.length > 0);
  return normalized.length === 0 ? undefined : normalized;
};

const encodeSseEvent = (encoder: TextEncoder, event: LedgerEvent): Uint8Array =>
  encoder.encode(
    [`id: ${event.id}`, "event: ledger", `data: ${JSON.stringify(eventToRpc(event))}`, "", ""].join(
      "\n",
    ),
  );

const encodeSseHeartbeat = (encoder: TextEncoder): Uint8Array => encoder.encode(": keepalive\n\n");

export const selectHandoffEvents = (
  afterId: number,
  snapshot: ReadonlyArray<LedgerEvent>,
  liveQueue: ReadonlyArray<LedgerEvent>,
): {
  readonly events: ReadonlyArray<LedgerEvent>;
  readonly watermark: number;
} => {
  let watermark = afterId;
  const events: LedgerEvent[] = [];
  for (const event of snapshot) {
    events.push(event);
    watermark = Math.max(watermark, event.id);
  }
  for (const event of liveQueue) {
    if (event.id > watermark) {
      events.push(event);
      watermark = event.id;
    }
  }
  return { events, watermark };
};

/** Build the SSE Response for a streamEvents call.
 *
 *  `runtime` must provide Ledger + EventBus. Any runtime whose service
 *  union includes both is assignable here (e.g. AgentDOBase's
 *  CoreServices runtime). `scope` filters which bus events reach the
 *  sink and which ledger rows the snapshot draws from. */
export const createEventStreamResponse = <R, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
  scope: string,
  opts: StreamEventsOptions = {},
): Response => {
  const afterId = normalizePositiveInteger(opts.afterId, 0);
  const heartbeatMs = Math.max(
    1,
    normalizePositiveInteger(opts.heartbeatMs, DEFAULT_STREAM_HEARTBEAT_MS),
  );
  const kinds = normalizeKinds(opts.kinds);
  const encoder = new TextEncoder();

  let closed = false;
  let cleanup: (() => void) | undefined;
  let heartbeatHandle: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const close = (): void => {
        if (closed) return;
        closed = true;
        cleanup?.();
        if (heartbeatHandle !== undefined) {
          clearInterval(heartbeatHandle);
        }
        try {
          controller.close();
        } catch {
          // The client may have already cancelled the stream.
        }
      };

      const enqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };

      try {
        // The runtime is contravariant in R from the caller's perspective:
        // any runtime that *provides* Ledger + EventBus (alongside others)
        // can run an Effect that only *requires* those two. We cast to a
        // narrowed runtime view at the boundary so the Effect's R is
        // exactly `Ledger | EventBus` instead of the caller's wider union.
        const narrow = runtime as unknown as ManagedRuntime.ManagedRuntime<
          Ledger | EventBus,
          unknown
        >;
        narrow.runSync(
          Effect.gen(function* () {
            const bus = yield* EventBus;
            const ledger = yield* Ledger;
            let watermark = afterId;
            const liveQueue: LedgerEvent[] = [];
            let mode: "buffering" | "live" = "buffering";

            const subscription = bus.subscribe({
              kinds,
              sink: (event) => {
                if (event.scope !== scope) return;
                if (mode === "buffering") {
                  liveQueue.push(event);
                  return;
                }
                if (event.id > watermark) {
                  enqueue(encodeSseEvent(encoder, event));
                  watermark = event.id;
                }
              },
            });
            cleanup = () => subscription.unsubscribe();

            const snapshot = yield* ledger.streamSnapshot(scope, {
              afterId,
              kinds,
            });
            const handoff = selectHandoffEvents(watermark, snapshot, liveQueue);
            for (const event of handoff.events) {
              enqueue(encodeSseEvent(encoder, event));
              watermark = event.id;
            }
            liveQueue.length = 0;
            mode = "live";
          }),
        );
        heartbeatHandle = setInterval(() => {
          enqueue(encodeSseHeartbeat(encoder));
        }, heartbeatMs);
      } catch (cause) {
        cleanup?.();
        if (heartbeatHandle !== undefined) {
          clearInterval(heartbeatHandle);
        }
        closed = true;
        controller.error(cause);
      }
    },
    cancel: () => {
      closed = true;
      cleanup?.();
      if (heartbeatHandle !== undefined) {
        clearInterval(heartbeatHandle);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
};
