import { Effect } from "effect";
import type { BackendProtocolEventHandler, BackendProtocolLedgerEventRpc } from "../index";

export const fireBackendEventHandlers = (
  handlers: ReadonlyArray<BackendProtocolEventHandler>,
  event: BackendProtocolLedgerEventRpc,
  label: string,
): Effect.Effect<void> =>
  Effect.withSpan("agentos.backends.protocol.fire_event_handlers")(
    Effect.forEach(
      handlers,
      (handler) =>
        Effect.tryPromise({
          try: () => Promise.resolve(handler(event)),
          catch: (cause) => cause,
        }).pipe(
          Effect.timeout("5 seconds"),
          Effect.catchIf(
            (_cause: unknown): _cause is unknown => true,
            (cause) =>
              Effect.sync(() => {
                console.error(`[agent-os] ${label} "${event.kind}" failed/timed:`, cause);
              }),
          ),
        ),
      { concurrency: 1, discard: true },
    ),
  );
