import type { ExtensionCapability, ExtensionDeclaration } from "@agent-os/core/extensions";
import type { RefResolver, RefResolverService } from "@agent-os/core/ref-resolver";
import type { EventHandler } from "@agent-os/core/types";
import type { LlmTransport } from "@agent-os/core/llm-protocol";
import type { AnyMaterializedProjectionDefinition } from "@agent-os/runtime";
import type { AgentManifest, DeploymentSpec } from "@agent-os/core/runtime-protocol";
import { Layer } from "effect";
import { MissingLlmTransportLive } from "./llm";
import {
  mountCloudflareAgent,
  type CloudflareAgentBindings,
  type CloudflareAgentMount,
} from "./mount";
import type { DispatchTargetRegistry } from "./dispatch/dispatch";
import type { CloudflareAttachedStreamSource } from "./stream-factory";
import type { CloudflareTriggerSource } from "./trigger-factory";

export interface CloudflareAgentEnv {}

export interface AgentDeclaredIntent {
  readonly kind: string;
  readonly boundaryOwnerId: string;
}

export interface AgentEventHandlerRegistration {
  readonly kind: string;
  readonly handler: EventHandler;
}

export interface AgentEventHandlerContext<Runtime = unknown> {
  readonly runtime: Runtime;
  readonly capabilities: ReadonlyMap<string, ExtensionCapability>;
}

export type CloudflareAgentProjectionSource<Env extends CloudflareAgentEnv> =
  | ReadonlyArray<AnyMaterializedProjectionDefinition>
  | ((env: Env) => ReadonlyArray<AnyMaterializedProjectionDefinition>);

export interface AgentDurableObjectConfig<Env extends CloudflareAgentEnv, Runtime = unknown> {
  readonly manifest: AgentManifest;
  readonly agentBindings: CloudflareAgentBindings;
  readonly refResolver?: (env: Env) => RefResolver;
  readonly llmTransport?: (env: Env) => Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly extensions?: (env: Env) => ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents?: (env: Env) => ReadonlyArray<AgentDeclaredIntent>;
  readonly dispatchTargets?: (env: Env) => DispatchTargetRegistry;
  readonly triggers?: CloudflareTriggerSource<Env>;
  readonly streams?: CloudflareAttachedStreamSource<Env>;
  readonly projections?: CloudflareAgentProjectionSource<Env>;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext<Runtime>,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
}

type AgentRuntimeConfig<Env extends CloudflareAgentEnv, Runtime = unknown> = Omit<
  AgentDurableObjectConfig<Env, Runtime>,
  "manifest"
>;

export interface CloudflareAgentDeploymentSpec<
  Env extends CloudflareAgentEnv,
  Runtime = unknown,
> extends AgentRuntimeConfig<Env, Runtime> {
  readonly deployment: DeploymentSpec;
}

export interface MaterializedAgentConfig<Env extends CloudflareAgentEnv, Runtime = unknown> {
  readonly mount: CloudflareAgentMount;
  readonly refResolver: RefResolver;
  readonly llmTransport: Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents: ReadonlyArray<AgentDeclaredIntent>;
  readonly dispatchTargets: DispatchTargetRegistry;
  readonly triggers: CloudflareTriggerSource<Env>;
  readonly streams: CloudflareAttachedStreamSource<Env>;
  readonly eventHandlers?: (
    context: AgentEventHandlerContext<Runtime>,
    env: Env,
  ) => Iterable<AgentEventHandlerRegistration>;
}

const emptyRefResolver: RefResolver = {
  material: () => null,
};

const projectionsFor = <Env extends CloudflareAgentEnv>(
  projections: CloudflareAgentProjectionSource<Env> | undefined,
  env: Env,
): ReadonlyArray<AnyMaterializedProjectionDefinition> =>
  typeof projections === "function" ? projections(env) : (projections ?? []);

export const materializeCloudflareAgentConfig = <Env extends CloudflareAgentEnv, Runtime = unknown>(
  manifest: AgentManifest,
  config: AgentRuntimeConfig<Env, Runtime>,
  env: Env,
): MaterializedAgentConfig<Env, Runtime> => {
  const materialized = projectionsFor(config.projections, env);
  return {
    mount: mountCloudflareAgent(manifest, config.agentBindings, { materialized }),
    refResolver: config.refResolver?.(env) ?? emptyRefResolver,
    llmTransport: config.llmTransport?.(env) ?? MissingLlmTransportLive,
    extensions: config.extensions?.(env) ?? [],
    declaredIntents: config.declaredIntents?.(env) ?? [],
    dispatchTargets: config.dispatchTargets?.(env) ?? {},
    triggers: config.triggers ?? [],
    streams: config.streams ?? [],
    eventHandlers: config.eventHandlers,
  };
};

export const materializeCloudflareAgentDeployment = <
  Env extends CloudflareAgentEnv,
  Runtime = unknown,
>(
  spec: CloudflareAgentDeploymentSpec<Env, Runtime>,
  env: Env,
): MaterializedAgentConfig<Env, Runtime> =>
  materializeCloudflareAgentConfig(spec.deployment.manifest, spec, env);
