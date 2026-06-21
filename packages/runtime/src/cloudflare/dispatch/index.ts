/**
 * Dispatch public barrel.
 *
 * Runtime Cloudflare dispatch modules are split by protocol role. All
 * imports `from "./dispatch"` resolve here via dir-as-module.
 *
 *   dispatch.ts   Dispatch Tag + DispatchLive orchestrator
 *   receiver.ts   inbound accepted + dedupe
 *   payload.ts    parse + trace-context helpers (leaf)
 */

export { Dispatch } from "@agent-os/runtime";
export type { DispatchEnvelope, DispatchReceiver } from "@agent-os/core/backend-protocol";
export {
  DispatchLive,
  DISPATCH_INBOUND_ACCEPTED,
  deliveryRetryTrigger,
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
