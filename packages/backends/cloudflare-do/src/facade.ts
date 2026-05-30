import type { DurableObject } from "cloudflare:workers";
import type { ExtensionDeclaration } from "@agent-os/kernel/extensions";
import type { ScopeRef } from "@agent-os/kernel/effect-claim";
import type { DispatchToScopeResult, DispatchToScopeSpec } from "@agent-os/kernel/types";
import type { AnyDurableTrigger, SubmitResult } from "@agent-os/runtime";
import {
  AgentDurableObject,
  type AgentEventHandlerContext,
  type AgentEventHandlerRegistration,
  type AgentRuntimeReaderClient,
  type AgentSubmitDefaults,
  type AgentSubmitSpec,
  type AgentTriggerIntentSpec,
  type CloudflareAgentEnv,
  type MaterializedAgentConfig,
} from "./agent-do";
import {
  lowerAgentConfig,
  type AgentLoweringConfig,
  type LoweredAgentConfig,
  type LoweredAgentConfigWithSubmit,
  type LoweredAgentConfigWithoutSubmit,
  type LlmRouteMap,
} from "./facade-lowering";

export interface AgentFacadeRuntimeClient extends AgentRuntimeReaderClient {
  readonly emit: (event: string, data: unknown) => Promise<{ id: number }>;
  readonly enqueueTrigger: (spec: AgentTriggerIntentSpec) => Promise<{ id: number }>;
  readonly dispatch: (spec: DispatchToScopeSpec) => Promise<DispatchToScopeResult>;
  readonly schedule: (
    event: string,
    data: unknown,
    options: { readonly at: number },
  ) => Promise<{ id: number }>;
}

export interface AgentFacadeRuntimeClientWithSubmit extends AgentFacadeRuntimeClient {
  readonly submit: (spec: AgentSubmitSpec) => Promise<SubmitResult>;
}

export type AgentDOClass<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
> = {
  new (ctx: DurableObjectState, env: Env): DurableObject<Env> & Runtime;
};

export type AgentOnHandler<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
> = (input: {
  readonly event: Parameters<AgentEventHandlerRegistration["handler"]>[0];
  readonly data: unknown;
  readonly agent: Runtime;
  readonly env: Env;
}) => void | Promise<void>;

interface DefineAgentDOConfigBase<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
> extends Omit<AgentLoweringConfig<Env>, "llms"> {
  readonly on?: Readonly<Record<string, AgentOnHandler<Env, Runtime>>>;
  readonly extensions?:
    | ReadonlyArray<ExtensionDeclaration>
    | ((env: Env) => ReadonlyArray<ExtensionDeclaration>);
  readonly scopeRefForScope?: (scope: string, env: Env) => ScopeRef | null;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext<Runtime>,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
  readonly triggers?:
    | ReadonlyArray<AnyDurableTrigger>
    | ((env: Env) => ReadonlyArray<AnyDurableTrigger>);
}

export interface DefineAgentDOConfigWithSubmit<
  Env extends CloudflareAgentEnv,
> extends DefineAgentDOConfigBase<Env, AgentFacadeRuntimeClientWithSubmit> {
  readonly llms: LlmRouteMap;
}

export interface DefineAgentDOConfigWithoutSubmit<
  Env extends CloudflareAgentEnv,
> extends DefineAgentDOConfigBase<Env, AgentFacadeRuntimeClient> {
  readonly llms?: undefined;
}

export type DefineAgentDOConfig<Env extends CloudflareAgentEnv> =
  | DefineAgentDOConfigWithSubmit<Env>
  | DefineAgentDOConfigWithoutSubmit<Env>;

const extensionsFor = <Env extends CloudflareAgentEnv>(
  extensions: DefineAgentDOConfig<Env>["extensions"],
  env: Env,
): ReadonlyArray<ExtensionDeclaration> =>
  typeof extensions === "function" ? extensions(env) : (extensions ?? []);

const eventHandlersFor = <Env extends CloudflareAgentEnv, Runtime extends AgentFacadeRuntimeClient>(
  config: DefineAgentDOConfigBase<Env, Runtime>,
  context: AgentEventHandlerContext<Runtime>,
  env: Env,
): ReadonlyArray<AgentEventHandlerRegistration> => {
  const registrations: AgentEventHandlerRegistration[] = [];
  for (const [kind, handler] of Object.entries(config.on ?? {})) {
    registrations.push({
      kind,
      handler: (event) =>
        Promise.resolve(handler({ event, data: event.payload, agent: context.runtime, env })),
    });
  }
  for (const registration of config.eventHandlers?.(context, env) ?? []) {
    registrations.push(registration);
  }
  return registrations;
};

const materializedConfigForEnv = <
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
>(
  config: DefineAgentDOConfigBase<Env, Runtime>,
  lowered: LoweredAgentConfig,
  env: Env,
): MaterializedAgentConfig<Env, Runtime> => ({
  refResolver: lowered.refResolver,
  extensions: extensionsFor(config.extensions, env),
  dispatchTargets: lowered.dispatchTargets,
  triggers: typeof config.triggers === "function" ? config.triggers(env) : (config.triggers ?? []),
  scopeRefForScope: config.scopeRefForScope ?? (() => null),
  eventHandlers: (context, eventEnv) => eventHandlersFor(config, context, eventEnv),
});

export function defineAgentDO<Env extends CloudflareAgentEnv>(
  config: DefineAgentDOConfigWithSubmit<Env>,
): AgentDOClass<Env, AgentFacadeRuntimeClientWithSubmit>;
export function defineAgentDO<Env extends CloudflareAgentEnv>(
  config: DefineAgentDOConfigWithoutSubmit<Env>,
): AgentDOClass<Env, AgentFacadeRuntimeClient>;
export function defineAgentDO<Env extends CloudflareAgentEnv>(
  config: DefineAgentDOConfig<Env>,
):
  | AgentDOClass<Env, AgentFacadeRuntimeClient>
  | AgentDOClass<Env, AgentFacadeRuntimeClientWithSubmit> {
  if (config.llms !== undefined) {
    const lowered = new WeakMap<Env, LoweredAgentConfigWithSubmit>();
    const getLowered = (env: Env): LoweredAgentConfigWithSubmit => {
      const existing = lowered.get(env);
      if (existing !== undefined) return existing;
      const next = lowerAgentConfig(config, env);
      lowered.set(env, next);
      return next;
    };

    return class FacadeAgentDurableObjectWithSubmit
      extends AgentDurableObject<Env, AgentFacadeRuntimeClientWithSubmit>
      implements AgentFacadeRuntimeClientWithSubmit
    {
      private readonly _submitDefaults: AgentSubmitDefaults;

      constructor(ctx: DurableObjectState, env: Env) {
        const next = getLowered(env);
        super(ctx, env, materializedConfigForEnv(config, next, env));
        this._submitDefaults = next.defaultSubmit;
      }

      submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
        return this.submitWithDefaults(spec, this._submitDefaults);
      }

      emit(event: string, data: unknown): Promise<{ id: number }> {
        return this.emitEventFull({ event, data });
      }

      enqueueTrigger(spec: AgentTriggerIntentSpec): Promise<{ id: number }> {
        return this.enqueueTriggerFull(spec);
      }

      dispatch(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult> {
        return this.dispatchToScopeFull(spec);
      }

      schedule(
        event: string,
        data: unknown,
        options: { readonly at: number },
      ): Promise<{ id: number }> {
        return this.scheduleEventFull({ event, data, at: options.at });
      }
    };
  }

  const eventOnlyConfig = config;
  const lowered = new WeakMap<Env, LoweredAgentConfigWithoutSubmit>();
  const getLowered = (env: Env): LoweredAgentConfigWithoutSubmit => {
    const existing = lowered.get(env);
    if (existing !== undefined) return existing;
    const next = lowerAgentConfig(eventOnlyConfig, env);
    lowered.set(env, next);
    return next;
  };

  return class FacadeAgentDurableObject
    extends AgentDurableObject<Env, AgentFacadeRuntimeClient>
    implements AgentFacadeRuntimeClient
  {
    constructor(ctx: DurableObjectState, env: Env) {
      const next = getLowered(env);
      super(
        ctx,
        env,
        materializedConfigForEnv<Env, AgentFacadeRuntimeClient>(eventOnlyConfig, next, env),
      );
    }

    emit(event: string, data: unknown): Promise<{ id: number }> {
      return this.emitEventFull({ event, data });
    }

    enqueueTrigger(spec: AgentTriggerIntentSpec): Promise<{ id: number }> {
      return this.enqueueTriggerFull(spec);
    }

    dispatch(spec: DispatchToScopeSpec): Promise<DispatchToScopeResult> {
      return this.dispatchToScopeFull(spec);
    }

    schedule(
      event: string,
      data: unknown,
      options: { readonly at: number },
    ): Promise<{ id: number }> {
      return this.scheduleEventFull({ event, data, at: options.at });
    }
  };
}

export {
  anthropicMessages,
  binding,
  cfAiBinding,
  credential,
  durableObjectTarget,
  endpoint,
  externalResource,
  geminiGenerateContent,
  openAIChat,
} from "./facade-lowering";
export type {
  AgentMaterialBinding,
  AgentMaterialBindingBuilder,
  AnthropicMessagesSpec,
  BindingMaterialRef,
  CfAiBindingSpec,
  CredentialMaterialRef,
  EndpointMaterialRef,
  ExternalResourceMaterialRef,
  GeminiGenerateContentSpec,
  OpenAIChatSpec,
} from "./facade-lowering";
