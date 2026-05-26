/**
 * EventBus — module-private reactive dispatcher.
 *
 * Ledger.log fires bus.fire(event) after committing the row. The bus looks up
 * the handler Set for that kind and runs each handler sequentially, bounded
 * by a 5-second timeout per handler. Handler exceptions are absorbed
 * (console.error'd) and never propagate to the main agent loop.
 *
 * The handlers Map is owned by AgentDOBase and passed in at Layer build time.
 */

import { Context, Effect, Layer } from "effect";
import type { EventHandler, LedgerEvent, LedgerEventRpc } from "../types";

export interface EventBusSubscription {
  readonly unsubscribe: () => void;
}

interface EventBusSink {
  readonly kinds?: ReadonlySet<string>;
  readonly sink: (event: LedgerEvent) => void;
}

export class EventBus extends Context.Tag("@agent-os/EventBus")<
  EventBus,
  {
    readonly fire: (event: LedgerEvent) => Effect.Effect<void>;
    readonly subscribe: (opts: {
      readonly kinds?: ReadonlyArray<string>;
      readonly sink: (event: LedgerEvent) => void;
    }) => EventBusSubscription;
  }
>() {}

export const EventBusLive = (
  handlers: Map<string, Set<EventHandler>>,
): Layer.Layer<EventBus> => {
  const sinks = new Set<EventBusSink>();
  return Layer.succeed(EventBus, {
    subscribe: (opts) => {
      const subscription: EventBusSink = {
        ...(opts.kinds === undefined || opts.kinds.length === 0
          ? {}
          : { kinds: new Set(opts.kinds) }),
        sink: opts.sink,
      };
      sinks.add(subscription);
      return {
        unsubscribe: () => {
          sinks.delete(subscription);
        },
      };
    },
    fire: (event) => {
      const handlerSet = handlers.get(event.kind);
      const fireSinks = Effect.sync(() => {
        const streamSinks = Array.from(sinks);
        for (const subscription of streamSinks) {
          if (
            subscription.kinds === undefined ||
            subscription.kinds.has(event.kind)
          ) {
            subscription.sink(event);
          }
        }
      });
      if (handlerSet === undefined || handlerSet.size === 0) {
        return fireSinks;
      }
      const list = Array.from(handlerSet);
      const rpcEvent: LedgerEventRpc = {
        id: event.id,
        ts: event.ts,
        kind: event.kind,
        scope: event.scope,
        payload: event.payload,
      };
      // Sequential dispatch; each handler isolated by timeout + catchAll.
      // Timeout bounds OUR wait, not the handler's own continued execution.
      return fireSinks.pipe(
        Effect.andThen(
          Effect.forEach(
            list,
            (handler) =>
              Effect.tryPromise({
                try: () => handler(rpcEvent),
                catch: (cause) => cause,
              }).pipe(
                Effect.timeout("5 seconds"),
                Effect.catchAll((cause) =>
                  Effect.sync(() => {
                    console.error(
                      `[agent-os] handler for "${event.kind}" failed/timed:`,
                      cause,
                    );
                  }),
                ),
              ),
            { concurrency: 1, discard: true },
          ),
        ),
      );
    },
  });
};
