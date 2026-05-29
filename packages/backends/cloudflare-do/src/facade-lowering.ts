import { Option } from "effect";
import type {
  AnthropicMessagesRoute,
  CfAiBindingRoute,
  GeminiGenerateContentRoute,
  LlmRoute,
  OpenAIChatCompatibleRoute,
} from "@agent-os/kernel/llm";
import { llmRouteMaterialRefs } from "@agent-os/kernel/llm";
import {
  bindingMaterialRef,
  credentialMaterialRef,
  endpointMaterialRef,
  externalResourceMaterialRef,
  isMaterialRef,
  materialRefKey,
  type BindingMaterialRef,
  type CredentialMaterialRef,
  type EndpointMaterialRef,
  type ExternalResourceMaterialRef,
  type MaterialRef,
} from "@agent-os/kernel/material-ref";
import type { RefResolver } from "@agent-os/kernel/ref-resolver";
import type { Tool } from "@agent-os/kernel/tools";
import type { DispatchTargetNamespace, DispatchTargetRegistry } from "./dispatch";

export interface AgentMaterialBinding<Env, Value = unknown> {
  readonly ref: MaterialRef;
  readonly resolve: (env: Env) => Value;
}

export interface AgentMaterialBindingBuilder<Env, Value = unknown> {
  readonly ref: MaterialRef;
  readonly from: (resolve: (env: Env) => Value) => AgentMaterialBinding<Env, Value>;
}

const materialBinding = <Env, Value>(
  ref: MaterialRef,
): AgentMaterialBindingBuilder<Env, Value> => ({
  ref,
  from: (resolve) => ({ ref, resolve }),
});

export const endpoint = <Env = unknown>(ref: string): AgentMaterialBindingBuilder<Env, string> =>
  materialBinding(endpointMaterialRef(ref));

export const credential = <Env = unknown>(
  ref: string,
  options: { readonly provider?: string; readonly purpose?: string } = {},
): AgentMaterialBindingBuilder<Env, string> => materialBinding(credentialMaterialRef(ref, options));

export const binding = <Env = unknown, Value = unknown>(
  provider: string,
  bindingKind: string,
  ref: string,
): AgentMaterialBindingBuilder<Env, Value> =>
  materialBinding(bindingMaterialRef({ provider, bindingKind, ref }));

export const externalResource = <Env = unknown, Value = unknown>(
  provider: string,
  resourceKind: string,
  ref: string,
): AgentMaterialBindingBuilder<Env, Value> =>
  materialBinding(externalResourceMaterialRef({ provider, resourceKind, ref }));

export const durableObjectTarget = <Env = unknown>(
  ref: string,
): AgentMaterialBindingBuilder<Env, DispatchTargetNamespace> =>
  binding<Env, DispatchTargetNamespace>("cloudflare", "durable_object", ref);

export interface OpenAIChatSpec {
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string;
}

export interface AnthropicMessagesSpec {
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string;
  readonly anthropicVersion?: string;
}

export interface GeminiGenerateContentSpec {
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string;
}

export interface CfAiBindingSpec {
  readonly model: string;
  readonly gatewayRef?: string;
}

export const openAIChat = (spec: OpenAIChatSpec): OpenAIChatCompatibleRoute => ({
  kind: "openai-chat-compatible",
  modelId: spec.model,
  endpointRef: spec.endpoint,
  credentialRef: spec.credential,
});

export const anthropicMessages = (spec: AnthropicMessagesSpec): AnthropicMessagesRoute => ({
  kind: "anthropic-messages",
  modelId: spec.model,
  endpointRef: spec.endpoint,
  credentialRef: spec.credential,
  ...(spec.anthropicVersion === undefined ? {} : { anthropicVersion: spec.anthropicVersion }),
});

export const geminiGenerateContent = (
  spec: GeminiGenerateContentSpec,
): GeminiGenerateContentRoute => ({
  kind: "gemini-generate-content",
  modelId: spec.model,
  endpointRef: spec.endpoint,
  credentialRef: spec.credential,
});

export const cfAiBinding = (spec: CfAiBindingSpec): CfAiBindingRoute => ({
  kind: "cf-ai-binding",
  modelId: spec.model,
  ...(spec.gatewayRef === undefined ? {} : { gatewayRef: spec.gatewayRef }),
});

export type LlmRouteMap = { readonly default: LlmRoute } & Readonly<Record<string, LlmRoute>>;

export interface AgentLoweringConfigBase<Env> {
  readonly bindings?: ReadonlyArray<AgentMaterialBinding<Env>>;
  readonly tools?: ReadonlyArray<Tool>;
}

export interface AgentLoweringConfigWithSubmit<Env> extends AgentLoweringConfigBase<Env> {
  readonly llms: LlmRouteMap;
}

export interface AgentLoweringConfigWithoutSubmit<Env> extends AgentLoweringConfigBase<Env> {
  readonly llms?: undefined;
}

export type AgentLoweringConfig<Env> =
  | AgentLoweringConfigWithSubmit<Env>
  | AgentLoweringConfigWithoutSubmit<Env>;

export interface LoweredAgentConfigBase {
  readonly refResolver: RefResolver;
  readonly dispatchTargets: DispatchTargetRegistry;
}

export interface LoweredAgentConfigWithSubmit extends LoweredAgentConfigBase {
  readonly defaultSubmit: {
    readonly route: LlmRoute;
    readonly tools: Record<string, Tool>;
  };
}

export interface LoweredAgentConfigWithoutSubmit extends LoweredAgentConfigBase {
  readonly defaultSubmit: null;
}

export type LoweredAgentConfig = LoweredAgentConfigWithSubmit | LoweredAgentConfigWithoutSubmit;

const isCloudflareDurableObjectBinding = (ref: MaterialRef): ref is BindingMaterialRef =>
  ref.kind === "binding" && ref.provider === "cloudflare" && ref.bindingKind === "durable_object";

const isDispatchTargetNamespace = (value: unknown): value is DispatchTargetNamespace =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly idFromName?: unknown }).idFromName === "function" &&
  typeof (value as { readonly get?: unknown }).get === "function";

const materialRefLabel = (ref: MaterialRef): string => materialRefKey(ref);

const failAgentConfig = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

const requireResolvedMaterial = (key: string, value: unknown): NonNullable<unknown> => {
  if (value === null || value === undefined) {
    return failAgentConfig(`material binding ${key} resolved to ${value}`);
  }
  return value;
};

const toolsToRecord = (tools: ReadonlyArray<Tool> = []): Record<string, Tool> => {
  const out: Record<string, Tool> = {};
  for (const tool of tools) {
    const name = tool.definition.function.name;
    if (out[name] !== undefined) {
      return failAgentConfig(`duplicate tool ${name}`);
    }
    out[name] = tool;
  }
  return out;
};

export function lowerAgentConfig<Env>(
  config: AgentLoweringConfigWithSubmit<Env>,
  env: Env,
): LoweredAgentConfigWithSubmit;
export function lowerAgentConfig<Env>(
  config: AgentLoweringConfigWithoutSubmit<Env>,
  env: Env,
): LoweredAgentConfigWithoutSubmit;
export function lowerAgentConfig<Env>(
  config: AgentLoweringConfig<Env>,
  env: Env,
): LoweredAgentConfig {
  const materials = new Map<string, NonNullable<unknown>>();
  const dispatchTargets: Record<string, DispatchTargetNamespace> = {};

  for (const binding of config.bindings ?? []) {
    if (!isMaterialRef(binding.ref)) {
      return failAgentConfig("invalid material binding ref");
    }
    const key = materialRefKey(binding.ref);
    if (materials.has(key)) {
      return failAgentConfig(`duplicate material binding ${key}`);
    }
    const value = requireResolvedMaterial(key, binding.resolve(env));
    materials.set(key, value);
    if (isCloudflareDurableObjectBinding(binding.ref)) {
      if (!isDispatchTargetNamespace(value)) {
        return failAgentConfig(`dispatch target ${key} is not a DurableObjectNamespace`);
      }
      dispatchTargets[key] = value;
    }
  }

  for (const [id, route] of Object.entries(config.llms ?? {})) {
    for (const ref of llmRouteMaterialRefs(route)) {
      const key = materialRefKey(ref);
      if (!materials.has(key)) {
        return failAgentConfig(`llm ${id} references unbound material ${materialRefLabel(ref)}`);
      }
    }
  }

  const refResolver: RefResolver = {
    material: (ref) => materials.get(materialRefKey(ref)) ?? null,
  };
  const tools = toolsToRecord(config.tools);
  return {
    refResolver,
    dispatchTargets,
    defaultSubmit:
      config.llms === undefined
        ? null
        : {
            route: config.llms.default,
            tools,
          },
  };
}

export type {
  BindingMaterialRef,
  CredentialMaterialRef,
  EndpointMaterialRef,
  ExternalResourceMaterialRef,
};
