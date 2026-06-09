import { Effect } from "effect";
import type { BackendProtocolEventHandler, BackendProtocolLedgerEventRpc } from "../index";

export const fireBackendEventHandlers = (
  handlers: ReadonlyArray<BackendProtocolEventHandler>,
  event: BackendProtocolLedgerEventRpc,
  label: string,
): Effect.Effect<void> =>
  Effect.forEach(
    handlers,
    (handler) =>
      Effect.tryPromise({
        try: () => Promise.resolve(handler(event)),
        catch: (cause) => cause,
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.catchAll((cause) =>
          Effect.sync(() => {
            console.error(`[agent-os] ${label} "${event.kind}" failed/timed:`, cause);
          }),
        ),
      ),
    { concurrency: 1, discard: true },
  );
