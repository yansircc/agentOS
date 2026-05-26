/**
 * Dispatch public barrel.
 *
 * Replaces the former monolithic `packages/core/src/dispatch.ts`. All
 * imports `from "./dispatch"` resolve here via dir-as-module.
 *
 *   dispatch.ts   Dispatch Tag + DispatchLive orchestrator
 *   outbox.ts     dispatch_outbox schema + drain helpers
 *   receiver.ts   inbound accepted + dedupe
 *   payload.ts    parse + trace-context helpers (leaf)
 */

export {
  Dispatch,
  DispatchLive,
  DISPATCH_INBOUND_ACCEPTED,
  type DispatchEnvelope,
  type DispatchReceiver,
  type DispatchTargetNamespace,
  type DispatchTargetRegistry,
} from "./dispatch";
