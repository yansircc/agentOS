/**
 * Dispatch public barrel.
 *
 * Replaces the former monolithic `packages/backends/cloudflare-do/src/dispatch.ts`. All
 * imports `from "./dispatch"` resolve here via dir-as-module.
 *
 *   dispatch.ts   Dispatch Tag + DispatchLive orchestrator
 *   outbox.ts     dispatch_outbox schema + drain helpers
 *   receiver.ts   inbound accepted + dedupe
 *   payload.ts    parse + trace-context helpers (leaf)
 */

export { Dispatch, type DispatchEnvelope, type DispatchReceiver } from "@agent-os/runtime";
export {
  DispatchLive,
  DISPATCH_INBOUND_ACCEPTED,
  durableObjectDispatchTarget,
  httpDispatchTarget,
  providerDispatchTarget,
  queueDispatchTarget,
  type DispatchTargetNamespace,
  type DispatchTargetRegistry,
  type HttpDispatchTargetSpec,
  type ProviderDispatchTargetSpec,
  type QueueDispatchTargetBinding,
} from "./dispatch";
