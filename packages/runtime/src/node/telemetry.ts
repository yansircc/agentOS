import {
  backendProtocolEventIdentityKey,
  backendProtocolTruthIdentityKey,
  describeDispatchCause,
} from "@agent-os/core/backend-protocol";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import type { EventHandler, LedgerEvent } from "@agent-os/core/types";
import { eventToRpc } from "./backend-helpers";

export interface NodePostgresEventSink {
  readonly identityKey: string;
  readonly kind: string;
  readonly sink: (event: LedgerEvent) => void;
}

export const fireNodePostgresEvents = async (
  events: ReadonlyArray<LedgerEvent>,
  deps: {
    readonly sinks: ReadonlySet<NodePostgresEventSink>;
    readonly handlers: ReadonlyMap<string, ReadonlySet<EventHandler>>;
    readonly diagnostics: TelemetryFanoutDiagnostic[];
  },
): Promise<void> => {
  for (const event of events) {
    const identityKey = backendProtocolEventIdentityKey(event);
    for (const sink of Array.from(deps.sinks)) {
      if (sink.identityKey !== identityKey || sink.kind !== event.kind) continue;
      try {
        sink.sink(event);
      } catch (cause) {
        deps.diagnostics.push({
          phase: "sink",
          eventId: event.id,
          kind: event.kind,
          identityKey: backendProtocolTruthIdentityKey(event),
          message: describeDispatchCause(cause),
        });
      }
    }
    const handlers = deps.handlers.get(event.kind);
    if (handlers === undefined) continue;
    for (const handler of handlers) {
      try {
        await handler(eventToRpc(event));
      } catch {
        // Handler failures are post-commit diagnostics; a failed handler must
        // not prevent later handlers from observing the committed fact.
      }
    }
  }
};
