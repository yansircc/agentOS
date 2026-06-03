/**
 * @agent-os/backend-cloudflare-do public barrel.
 *
 * This package is the Cloudflare Durable Object backend instance. Pure
 * algebra comes from @agent-os/kernel; backend-neutral runtime contracts come
 * from @agent-os/runtime. Do not re-export those packages here.
 */

export { createAgentDurableObject, type CloudflareAgentEnv } from "./agent-do";
export type {
  AgentAttachedStreamCancelSpec,
  AgentAttachedStreamSpec,
  AgentDurableObjectConfig,
  AgentEventHandlerContext,
  AgentEventHandlerRegistration,
  AgentRuntimeClient,
  AgentRuntimeReaderClient,
  AgentSubmitSpec,
  AgentTriggerCancelSpec,
  AgentTriggerIntentSpec,
} from "./agent-do";
export type {
  CloudflareAttachedStreamFactory,
  CloudflareAttachedStreamFactoryContext,
  CloudflareAttachedStreamSource,
} from "./stream-factory";
export type {
  CloudflareTriggerFactory,
  CloudflareTriggerFactoryContext,
  CloudflareTriggerSource,
} from "./trigger-factory";
export {
  anthropicMessages,
  binding,
  cfAiBinding,
  credential,
  defineAgentDO,
  durableObjectTarget,
  endpoint,
  externalResource,
  geminiGenerateContent,
  lowerMaterialBindings,
  openAIChat,
} from "./facade";
export type {
  AgentDOClass,
  AgentFacadeRuntimeClient,
  AgentFacadeRuntimeClientWithSubmit,
  AgentMaterialBinding,
  AgentMaterialBindingBuilder,
  AgentOnHandler,
  AnthropicMessagesSpec,
  CfAiBindingSpec,
  DefineAgentDOConfig,
  DefineAgentDOConfigWithSubmit,
  DefineAgentDOConfigWithoutSubmit,
  GeminiGenerateContentSpec,
  LoweredMaterialBindings,
  OpenAIChatSpec,
} from "./facade";
export {
  durableObjectDispatchTarget,
  httpDispatchTarget,
  providerDispatchTarget,
  queueDispatchTarget,
} from "./dispatch";
export type {
  DispatchTargetNamespace,
  DispatchTargetRegistry,
  HttpDispatchTargetSpec,
  ProviderDispatchTargetSpec,
  QueueDispatchTargetBinding,
} from "./dispatch";
export { durableObjectRpcClient } from "./do-rpc";
export type { DurableObjectRpcClient } from "./do-rpc";
