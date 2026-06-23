import { Effect } from "effect";
import { backendProtocolTruthIdentityKey } from "@agent-os/core/backend-protocol";
import { fireBackendEventHandlers } from "@agent-os/core/backend-protocol/reference";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import type { EventHandler, LedgerEvent } from "@agent-os/core/types";
import { describeFanoutCause, eventToRpc, eventTruthIdentity } from "./state-helpers";

export interface InMemoryEventSink {
  readonly kinds?: ReadonlySet<string>;
  readonly sink: (event: LedgerEvent) => void;
}

export const fireInMemoryEvents = (
  events: ReadonlyArray<LedgerEvent>,
  deps: {
    readonly sinks: ReadonlySet<InMemoryEventSink>;
    readonly handlers: ReadonlyMap<string, ReadonlySet<EventHandler>>;
    readonly diagnostics: TelemetryFanoutDiagnostic[];
  },
): Effect.Effect<void> => {
  if (events.length === 0) return Effect.void;
  const fireSinks = Effect.sync(() => {
    const sinks = Array.from(deps.sinks);
    for (const event of events) {
      for (const subscription of sinks) {
        if (subscription.kinds === undefined || subscription.kinds.has(event.kind)) {
          try {
            subscription.sink(event);
          } catch (cause) {
            deps.diagnostics.push({
              phase: "sink",
              eventId: event.id,
              kind: event.kind,
              identityKey: backendProtocolTruthIdentityKey(eventTruthIdentity(event)),
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
          const handlers = deps.handlers.get(event.kind);
          if (handlers === undefined || handlers.size === 0) return Effect.void;
          return fireBackendEventHandlers(Array.from(handlers), eventToRpc(event), "event handler");
        },
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.withSpan("agentos.in_memory.telemetry.fire"),
  );
};
