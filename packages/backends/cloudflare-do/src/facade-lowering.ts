import { Option } from "effect";
import type { LlmRoute } from "@agent-os/core/llm-protocol";
import { llmRouteMaterialRefs } from "@agent-os/core/llm-protocol";
import {
  defineAgentSubmitBindings,
  type AgentSubmitBindings,
} from "@agent-os/core/runtime-protocol";
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
} from "@agent-os/core/material-ref";
import type { RefResolver } from "@agent-os/core/ref-resolver";
import {
  validateExecutionDomainRegistry,
  type ExecutionDomainDeclaration,
  type ExecutionDomainRegistryIssue,
  type Tool,
} from "@agent-os/core/tools";
import type { DispatchTargetAdapter } from "@agent-os/core/backend-protocol";
import { durableObjectDispatchTarget } from "./dispatch";
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

export interface OpenAIChatCompatibleRoute extends LlmRoute {
  readonly kind: "openai-chat-compatible";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
}

export interface AnthropicMessagesSpec {
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string;
  readonly anthropicVersion?: string;
}

export interface AnthropicMessagesRoute extends LlmRoute {
  readonly kind: "anthropic-messages";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
  readonly anthropicVersion?: string;
}

export interface GeminiGenerateContentSpec {
  readonly model: string;
  readonly endpoint: string;
  readonly credential: string;
}

export interface GeminiGenerateContentRoute extends LlmRoute {
  readonly kind: "gemini-generate-content";
  readonly endpointRef: string;
  readonly credentialRef: string;
  readonly modelId: string;
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

export type LlmRouteMap = { readonly default: LlmRoute } & Readonly<Record<string, LlmRoute>>;

export interface AgentLoweringConfigBase<Env> {
  readonly bindings?: ReadonlyArray<AgentMaterialBinding<Env>>;
  readonly tools?: ReadonlyArray<Tool>;
  readonly domains?: ReadonlyArray<ExecutionDomainDeclaration>;
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

export interface LoweredMaterialBindings {
  readonly refResolver: RefResolver;
  readonly dispatchTargets: DispatchTargetRegistry;
  readonly materialKeys: ReadonlySet<string>;
}

export interface LoweredAgentConfigWithSubmit extends LoweredAgentConfigBase {
  readonly submitBindings: AgentSubmitBindings;
}

export interface LoweredAgentConfigWithoutSubmit extends LoweredAgentConfigBase {
  readonly submitBindings: null;
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

const executionDomainIssueLabel = (issue: ExecutionDomainRegistryIssue): string => {
  switch (issue.kind) {
    case "invalid_declaration":
      return `invalid declaration at ${issue.index}`;
    case "duplicate_declaration":
      return `duplicate ${issue.domain.kind}:${issue.domain.ref}:${issue.access}`;
    case "invalid_write_snapshot_law":
      return `invalid write snapshot law for ${issue.domain.kind}:${issue.domain.ref}`;
    case "invalid_material_broker_declaration":
      return `invalid material broker declaration at ${issue.index}`;
    case "duplicate_material_broker_declaration":
      return `duplicate material broker declaration for ${issue.domain.kind}:${issue.domain.ref}`;
    case "missing_declaration":
      return `missing ${issue.domain.kind}:${issue.domain.ref}:${issue.access} for ${issue.toolId}`;
    case "access_mismatch":
      return `missing ${issue.domain.kind}:${issue.domain.ref}:${issue.access} for ${issue.toolId}; declared ${issue.declaredAccesses.join(",")}`;
  }
};

export const lowerMaterialBindings = <Env>(
  bindings: ReadonlyArray<AgentMaterialBinding<Env>> | undefined,
  env: Env,
): LoweredMaterialBindings => {
  const materialBindings = new Map<string, AgentMaterialBinding<Env>>();
  const dispatchTargets: Record<string, DispatchTargetAdapter> = {};

  for (const binding of bindings ?? []) {
    if (!isMaterialRef(binding.ref)) {
      return failAgentConfig("invalid material binding ref");
    }
    const key = materialRefKey(binding.ref);
    if (materialBindings.has(key)) {
      return failAgentConfig(`duplicate material binding ${key}`);
    }
    materialBindings.set(key, binding);
    if (isCloudflareDurableObjectBinding(binding.ref)) {
      dispatchTargets[key] = {
        deliver: (envelope) => {
          const value = requireResolvedMaterial(key, binding.resolve(env));
          if (!isDispatchTargetNamespace(value)) {
            return Promise.reject(
              new TypeError(`dispatch target ${key} is not a DurableObjectNamespace`),
            );
          }
          return durableObjectDispatchTarget(value).deliver(envelope);
        },
      };
    }
  }

  return {
    refResolver: {
      material: (ref) => {
        const key = materialRefKey(ref);
        const binding = materialBindings.get(key);
        return binding === undefined ? null : requireResolvedMaterial(key, binding.resolve(env));
      },
    },
    dispatchTargets,
    materialKeys: new Set(materialBindings.keys()),
  };
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
  const loweredMaterials = lowerMaterialBindings(config.bindings, env);

  for (const [id, route] of Object.entries(config.llms ?? {})) {
    for (const ref of llmRouteMaterialRefs(route)) {
      if (!loweredMaterials.materialKeys.has(materialRefKey(ref))) {
        return failAgentConfig(`llm ${id} references unbound material ${materialRefLabel(ref)}`);
      }
    }
  }

  const tools = toolsToRecord(config.tools);
  const domainRegistry = validateExecutionDomainRegistry(tools, {
    domains: config.domains ?? [],
  });
  if (!domainRegistry.ok) {
    return failAgentConfig(
      `invalid execution domain registry: ${domainRegistry.issues.map(executionDomainIssueLabel).join(", ")}`,
    );
  }

  return {
    refResolver: loweredMaterials.refResolver,
    dispatchTargets: loweredMaterials.dispatchTargets,
    submitBindings:
      config.llms === undefined
        ? null
        : defineAgentSubmitBindings({
            llmRoutes: config.llms,
            tools,
            executionDomains: config.domains ?? [],
          }),
  };
}

export type {
  BindingMaterialRef,
  CredentialMaterialRef,
  EndpointMaterialRef,
  ExternalResourceMaterialRef,
};
