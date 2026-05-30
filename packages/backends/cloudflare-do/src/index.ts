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
  AgentEventHandlerContext,
  AgentEventHandlerRegistration,
  AgentRuntimeClient,
  AgentRuntimeReaderClient,
  AgentSubmitSpec,
} from "./agent-do";
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
