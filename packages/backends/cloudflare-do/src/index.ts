/**
 * @agent-os/backend-cloudflare-do public barrel.
 *
 * This package is the Cloudflare Durable Object backend instance. Pure
 * algebra comes from @agent-os/kernel; backend-neutral runtime contracts come
 * from @agent-os/runtime. Do not re-export those packages here.
 */

export { createAgentDurableObject, type CloudflareAgentEnv } from "./agent-do";
export { cloudflareAgentMountPort, mountCloudflareAgent } from "./mount";
export * from "./ag-ui-sse";
export * from "./workspace-job-facade";
export * from "./workspace-job-profile";
export * from "./workspace-env";
export * from "./workspace-op";
export * from "./ops-api";
export type {
  AgentAttachedStreamCancelSpec,
  AgentAttachedStreamSpec,
  AgentDurableObjectConfig,
  AgentEventHandlerContext,
  AgentEventHandlerRegistration,
  AgentRuntimeClient,
  AgentRuntimeReaderClient,
  AgentSubmitSpec,
  AgentWorkspaceJobSpec,
  AgentTriggerCancelSpec,
  AgentTriggerIntentSpec,
} from "./agent-do";
export type {
  CloudflareAgentDriverConfig,
  CloudflareAgentMount,
  CloudflareAgentMountPort,
  CloudflareAgentProjectionSinks,
} from "./mount";
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
