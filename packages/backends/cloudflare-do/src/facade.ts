import type { ExtensionDeclaration } from "@agent-os/kernel/extensions";
import type { ScopeRef } from "@agent-os/kernel/effect-claim";
import type { DispatchToScopeResult, DispatchToScopeSpec } from "@agent-os/kernel/types";
import type { AttachedStreamCancelResult, TriggerCancelResult } from "@agent-os/runtime";
import { type AgentManifest, type SubmitResult } from "@agent-os/runtime-protocol";
import type { LlmTransport } from "@agent-os/llm-protocol";
import type { RefResolverService } from "@agent-os/kernel/ref-resolver";
import type { Layer } from "effect";
import {
  AgentDurableObject,
  type AgentAttachedStreamCancelSpec,
  type AgentAttachedStreamSpec,
  type AgentDeclaredIntent,
  type AgentEventHandlerContext,
  type AgentEventHandlerRegistration,
  type AgentSubmitSpec,
  type AgentWorkspaceJobSpec,
  type AgentTriggerCancelSpec,
  type AgentTriggerIntentSpec,
  type CloudflareAgentProjectionSource,
  type CloudflareAgentEnv,
  type MaterializedAgentConfig,
} from "./agent-do";
import { mountCloudflareAgent, type CloudflareAgentBindings } from "./mount";
import type { CloudflareTriggerSource } from "./trigger-factory";
import type { CloudflareAttachedStreamSource } from "./stream-factory";
import { MissingLlmTransportLive } from "./llm";
import {
  lowerAgentConfig,
  type AgentLoweringConfig,
  type LoweredAgentConfig,
  type LoweredAgentConfigWithSubmit,
  type LoweredAgentConfigWithoutSubmit,
  type LlmRouteMap,
} from "./facade-lowering";
import { cloudflareDefaultTruthIdentityFromRoutingScope } from "./ledger/identity";
import type { WorkspaceJobProjection } from "@agent-os/workspace-job";

export interface AgentFacadeRuntimeClient {
  readonly emit: (event: string, data: unknown) => Promise<{ id: number }>;
  readonly enqueueTrigger: (spec: AgentTriggerIntentSpec) => Promise<{ id: number }>;
  readonly cancelTrigger: (spec: AgentTriggerCancelSpec) => Promise<TriggerCancelResult>;
  readonly attachStream: (spec: AgentAttachedStreamSpec) => Promise<Response>;
  readonly cancelStream: (
    spec: AgentAttachedStreamCancelSpec,
  ) => Promise<AttachedStreamCancelResult>;
  readonly dispatch: (spec: DispatchToScopeSpec) => Promise<DispatchToScopeResult>;
  readonly schedule: (
    event: string,
    data: unknown,
    options: { readonly at: number },
  ) => Promise<{ id: number }>;
  readonly runWorkspaceJob: (spec: AgentWorkspaceJobSpec) => Promise<WorkspaceJobProjection>;
}

export interface AgentFacadeRuntimeClientWithSubmit extends AgentFacadeRuntimeClient {
  readonly submit: (spec: AgentSubmitSpec) => Promise<SubmitResult>;
}

export type AgentDOClass<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
> = {
  new (ctx: DurableObjectState, env: Env): AgentDurableObject<Env, Runtime> & Runtime;
};

export type AgentOnHandler<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
> = (input: {
  readonly event: Parameters<AgentEventHandlerRegistration["handler"]>[0];
  readonly data: unknown;
  readonly agent: Runtime;
  readonly capabilities: AgentEventHandlerContext<Runtime>["capabilities"];
  readonly env: Env;
}) => void | Promise<void>;

interface DefineAgentDOConfigBase<
  Env extends CloudflareAgentEnv,
  Runtime extends AgentFacadeRuntimeClient,
> extends Omit<AgentLoweringConfig<Env>, "llms"> {
  readonly manifest: AgentManifest;
  readonly agentBindings: CloudflareAgentBindings;
  readonly llmTransport?: (env: Env) => Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly on?: Readonly<Record<string, AgentOnHandler<Env, Runtime>>>;
  readonly extensions?:
    | ReadonlyArray<ExtensionDeclaration>
    | ((env: Env) => ReadonlyArray<ExtensionDeclaration>);
  readonly declaredIntents?:
    | ReadonlyArray<AgentDeclaredIntent>
    | ((env: Env) => ReadonlyArray<AgentDeclaredIntent>);
  readonly scopeRefForScope?: (scope: string, env: Env) => ScopeRef | null;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext<Runtime>,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
  readonly triggers?: CloudflareTriggerSource<Env>;
  readonly streams?: CloudflareAttachedStreamSource<Env>;
  readonly projections?: CloudflareAgentProjectionSource<Env>;
}

export interface DefineAgentDOConfigWithSubmit<
  Env extends CloudflareAgentEnv,
> extends DefineAgentDOConfigBase<Env, AgentFacadeRuntimeClientWithSubmit> {
  readonly llms: LlmRouteMap;
  readonly llmTransport: (env: Env) => Layer.Layer<LlmTransport, never, RefResolverService>;
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

const declaredIntentsFor = <Env extends CloudflareAgentEnv>(
  declaredIntents: DefineAgentDOConfig<Env>["declaredIntents"],
  env: Env,
): ReadonlyArray<AgentDeclaredIntent> =>
  typeof declaredIntents === "function" ? declaredIntents(env) : (declaredIntents ?? []);

const projectionsFor = <Env extends CloudflareAgentEnv>(
  projections: DefineAgentDOConfig<Env>["projections"],
  env: Env,
) => (typeof projections === "function" ? projections(env) : (projections ?? []));

const mountForConfig = <Env extends CloudflareAgentEnv, Runtime extends AgentFacadeRuntimeClient>(
  config: DefineAgentDOConfigBase<Env, Runtime>,
  _lowered: LoweredAgentConfig,
) => {
  return mountCloudflareAgent(config.manifest, config.agentBindings);
};

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
        Promise.resolve(
          handler({
            event,
            data: event.payload,
            agent: context.runtime,
            capabilities: context.capabilities,
            env,
          }),
        ),
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
): MaterializedAgentConfig<Env, Runtime> => {
  return {
    mount: mountForConfig(config, lowered),
    refResolver: lowered.refResolver,
    llmTransport: config.llmTransport?.(env) ?? MissingLlmTransportLive,
    extensions: extensionsFor(config.extensions, env),
    declaredIntents: declaredIntentsFor(config.declaredIntents, env),
    dispatchTargets: lowered.dispatchTargets,
    triggers: config.triggers ?? [],
    streams: config.streams ?? [],
    projections: projectionsFor(config.projections, env),
    scopeRefForScope:
      config.scopeRefForScope ??
      ((scope) => cloudflareDefaultTruthIdentityFromRoutingScope(scope).scopeRef),
    eventHandlers: (context, eventEnv) => eventHandlersFor(config, context, eventEnv),
  };
};

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
      private readonly _submitBindings: LoweredAgentConfigWithSubmit["submitBindings"];

      constructor(ctx: DurableObjectState, env: Env) {
        const next = getLowered(env);
        super(ctx, env, materializedConfigForEnv(config, next, env));
        this._submitBindings = next.submitBindings;
      }

      submit(spec: AgentSubmitSpec): Promise<SubmitResult> {
        return this.submitWithBindings(spec, this._submitBindings);
      }

      runWorkspaceJob(spec: AgentWorkspaceJobSpec): Promise<WorkspaceJobProjection> {
        return this.runWorkspaceJobFull(spec);
      }

      emit(event: string, data: unknown): Promise<{ id: number }> {
        return this.emitEventFull({ event, data });
      }

      enqueueTrigger(spec: AgentTriggerIntentSpec): Promise<{ id: number }> {
        return this.enqueueTriggerFull(spec);
      }

      cancelTrigger(spec: AgentTriggerCancelSpec): Promise<TriggerCancelResult> {
        return this.cancelTriggerFull(spec);
      }

      attachStream(spec: AgentAttachedStreamSpec): Promise<Response> {
        return this.attachStreamFull(spec);
      }

      cancelStream(spec: AgentAttachedStreamCancelSpec): Promise<AttachedStreamCancelResult> {
        return this.cancelStreamFull(spec);
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

    cancelTrigger(spec: AgentTriggerCancelSpec): Promise<TriggerCancelResult> {
      return this.cancelTriggerFull(spec);
    }

    attachStream(spec: AgentAttachedStreamSpec): Promise<Response> {
      return this.attachStreamFull(spec);
    }

    cancelStream(spec: AgentAttachedStreamCancelSpec): Promise<AttachedStreamCancelResult> {
      return this.cancelStreamFull(spec);
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

    runWorkspaceJob(spec: AgentWorkspaceJobSpec): Promise<WorkspaceJobProjection> {
      return this.runWorkspaceJobFull(spec);
    }
  };
}

export {
  anthropicMessages,
  binding,
  credential,
  durableObjectTarget,
  endpoint,
  externalResource,
  geminiGenerateContent,
  lowerMaterialBindings,
  openAIChat,
} from "./facade-lowering";
export type {
  AgentMaterialBinding,
  AgentMaterialBindingBuilder,
  AnthropicMessagesSpec,
  BindingMaterialRef,
  CredentialMaterialRef,
  EndpointMaterialRef,
  ExternalResourceMaterialRef,
  GeminiGenerateContentSpec,
  LoweredMaterialBindings,
  OpenAIChatSpec,
} from "./facade-lowering";
