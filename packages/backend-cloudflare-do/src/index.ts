/**
 * @agent-os/backend-cloudflare-do public barrel.
 *
 * This package is the Cloudflare Durable Object backend instance. Pure
 * algebra comes from @agent-os/kernel; backend-neutral runtime contracts come
 * from @agent-os/runtime. Do not re-export those packages here.
 */

export { createAgentDurableObject, type CloudflareAgentEnv } from "./agent-do";
export type {
  AgentDurableObjectConfig,
  AgentEventHandlerRegistration,
  AgentRuntimeClient,
} from "./agent-do";
export type { DispatchTargetNamespace, DispatchTargetRegistry } from "./dispatch";
