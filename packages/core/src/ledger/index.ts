/**
 * Ledger public barrel.
 *
 * Re-exports the three modules of the ledger surface — log + projection
 * (ledger.ts), reactive dispatch (event-bus.ts), SSE stream helper
 * (stream.ts). Replaces the former pair of root-level files at
 * src/ledger.ts + src/event-bus.ts so all reads come through a single
 * import path.
 */

export { Ledger, LedgerLive, eventToRpc } from "./ledger";
export {
  EventBus,
  EventBusLive,
  type EventBusSubscription,
} from "./event-bus";
export { createEventStreamResponse } from "./stream";
