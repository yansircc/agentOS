import type { LedgerEvent } from "@agent-os/kernel/types";
import { scopeRefKey } from "@agent-os/kernel/effect-claim";
/**
 * EventBus — module-private reactive dispatcher.
 *
 * Ledger.log fires bus.fire(event) after committing the row. The bus looks up
 * the handler Set for that kind and runs each handler sequentially, bounded
 * by a 5-second timeout per handler. Handler exceptions are absorbed
 * (console.error'd) and never propagate to the main agent loop.
 *
 * The handlers Map is owned by Cloudflare backend and passed in at Layer build time.
 */

import { Context, Effect, Layer } from "effect";
import type { EventHandler } from "@agent-os/kernel/types";
import { fireBackendEventHandlers } from "@agent-os/backend-protocol";

export interface EventBusSubscription {
  readonly unsubscribe: () => void;
}

interface EventBusSink {
  readonly kinds?: ReadonlySet<string>;
  readonly sink: (event: LedgerEvent) => void;
}

export interface EventBusFanoutDiagnostic {
  readonly phase: "sink";
  readonly eventId: number;
  readonly kind: string;
  readonly scopeKey: string;
  readonly message: string;
}

export interface EventBusService {
  readonly fire: (event: LedgerEvent) => Effect.Effect<void>;
  readonly fireMany: (events: ReadonlyArray<LedgerEvent>) => Effect.Effect<void>;
  readonly fanoutDiagnostics: () => ReadonlyArray<EventBusFanoutDiagnostic>;
  readonly subscribe: (opts: {
    readonly kinds?: ReadonlyArray<string>;
    readonly sink: (event: LedgerEvent) => void;
  }) => EventBusSubscription;
}

export class EventBus extends Context.Tag("@agent-os/EventBus")<EventBus, EventBusService>() {}

const describeFanoutCause = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return Object.prototype.toString.call(cause);
};

export const EventBusLive = (handlers: Map<string, Set<EventHandler>>): Layer.Layer<EventBus> => {
  const sinks = new Set<EventBusSink>();
  const diagnostics: EventBusFanoutDiagnostic[] = [];
  const service: EventBusService = {
    fanoutDiagnostics: () => [...diagnostics],
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
    fire: (event) => service.fireMany([event]),
    fireMany: (events) => {
      const fireSinks = Effect.sync(() => {
        const streamSinks = Array.from(sinks);
        for (const event of events) {
          for (const subscription of streamSinks) {
            if (subscription.kinds === undefined || subscription.kinds.has(event.kind)) {
              try {
                subscription.sink(event);
              } catch (cause) {
                diagnostics.push({
                  phase: "sink",
                  eventId: event.id,
                  kind: event.kind,
                  scopeKey: scopeRefKey(event.scopeRef),
                  message: describeFanoutCause(cause),
                });
              }
            }
          }
        }
      });
      return fireSinks.pipe(
        Effect.andThen(
          Effect.forEach(
            events,
            (event) => {
              const handlerSet = handlers.get(event.kind);
              if (handlerSet === undefined || handlerSet.size === 0) {
                return Effect.void;
              }
              return fireBackendEventHandlers(
                Array.from(handlerSet),
                {
                  id: event.id,
                  ts: event.ts,
                  kind: event.kind,
                  scopeRef: event.scopeRef,
                  factOwnerRef: event.factOwnerRef,
                  effectAuthorityRef: event.effectAuthorityRef,
                  payload: event.payload,
                },
                "event handler",
              );
            },
            { concurrency: 1, discard: true },
          ),
        ),
      );
    },
  };
  return Layer.succeed(EventBus, service);
};
