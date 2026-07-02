import { Layer, ManagedRuntime, Option } from "effect";
import type { EventHandler } from "@agent-os/core/types";
import { InvalidResourceAmount, SqlError, TriggerFactoryError } from "@agent-os/core/errors";
import type { AnyMaterializedProjectionDefinition, RuntimeStorageError } from "@agent-os/runtime";
import { Admission } from "@agent-os/runtime";
import { internalSubmitSpec, type InternalSubmitSpec } from "../internal-submit";
import { LlmTransport } from "@agent-os/core/llm-protocol";
import {
  lowerSubmitRunInput,
  RUNTIME_FACT_OWNER,
  type AgentSubmitBindings,
  type SubmitRunInput,
  type SubmitSpec,
  type SubmitToolIntent,
} from "@agent-os/core/runtime-protocol";
import type {
  BackendProtocolEventIdentity,
  BackendProtocolTruthIdentity,
} from "@agent-os/core/backend-protocol";
import type { DispatchTargetRegistry } from "./dispatch/dispatch";
import { AdmissionLive } from "./admission/admission";
import { RefResolverLive, RefResolverService, type RefResolver } from "@agent-os/core/ref-resolver";
import {
  type BoundaryPackage,
  type ExtensionDeclaration,
  extensionOwnsEvent,
  isBoundaryPackage,
} from "@agent-os/core/extensions";
import { makeCloudflareBackendCoreLayer, type CloudflareBackendCoreServices } from "./runtime-core";
import type { CloudflareAttachedStreamSource } from "./stream-factory";
import type { CloudflareTriggerSource } from "./trigger-factory";
import type { AgentDeclaredIntent, CloudflareAgentEnv } from "./deployment";
import { eventIdentity } from "./ledger/identity";
import type { ResolvedRuntimeGraphStatus } from "../runtime-graph-status";

export interface AgentSubmitSpecLike {
  readonly intent: string;
  readonly input: unknown;
  readonly llmRouteBindingRef?: string;
  readonly context?: Record<string, unknown>;
  readonly system?: string;
  readonly budget?: SubmitSpec["budget"];
  readonly outputSchema?: SubmitSpec["outputSchema"];
  readonly traceContext?: SubmitSpec["traceContext"];
  readonly dynamicCapability?: SubmitRunInput["dynamicCapability"];
  readonly materials?: SubmitRunInput["materials"];
  readonly toolContext?: SubmitRunInput["toolContext"];
  readonly toolPolicy?: SubmitSpec["toolPolicy"];
  readonly decisionInterrupts?: SubmitRunInput["decisionInterrupts"];
  readonly resume?: SubmitSpec["resume"];
}

export const submitRunInputFromAgentSpec = (spec: AgentSubmitSpecLike): SubmitRunInput => ({
  intent: spec.intent,
  context: spec.context ?? { input: spec.input },
  ...(spec.system === undefined ? {} : { system: spec.system }),
  ...(spec.budget === undefined ? {} : { budget: spec.budget }),
  ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
  ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  ...(spec.dynamicCapability === undefined ? {} : { dynamicCapability: spec.dynamicCapability }),
  ...(spec.materials === undefined ? {} : { materials: spec.materials }),
  ...(spec.toolContext === undefined ? {} : { toolContext: spec.toolContext }),
  ...(spec.toolPolicy === undefined ? {} : { toolPolicy: spec.toolPolicy }),
  ...(spec.decisionInterrupts === undefined ? {} : { decisionInterrupts: spec.decisionInterrupts }),
  ...(spec.resume === undefined ? {} : { resume: spec.resume }),
});

export const lowerAgentSubmitSpec = (
  spec: AgentSubmitSpecLike,
  baseBindings: AgentSubmitBindings,
  toolIntents: ReadonlyArray<SubmitToolIntent>,
  effectAuthorityRef: BackendProtocolTruthIdentity["effectAuthorityRef"],
): SubmitSpec =>
  lowerSubmitRunInput({
    input: submitRunInputFromAgentSpec(spec),
    bindings: {
      ...baseBindings,
      toolIntents: [...toolIntents, ...(baseBindings.toolIntents ?? [])],
    },
    routeBindingRef: spec.llmRouteBindingRef ?? "default",
    effectAuthorityRef,
  });

export const scopedInternalSubmitSpec = (
  scope: string,
  truthIdentity: BackendProtocolTruthIdentity,
  spec: SubmitSpec,
  runtimeGraphStatus?: ResolvedRuntimeGraphStatus,
): {
  readonly identity: BackendProtocolEventIdentity;
  readonly internalSpec: InternalSubmitSpec;
} => {
  const scopedSpec: SubmitSpec = {
    ...spec,
    effectAuthorityRef: truthIdentity.effectAuthorityRef,
  };
  return {
    identity: eventIdentity(truthIdentity, RUNTIME_FACT_OWNER),
    internalSpec: internalSubmitSpec(
      scopedSpec,
      {
        scope,
        scopeRef: truthIdentity.scopeRef,
      },
      { runtimeGraphStatus },
    ),
  };
};

export const promiseFromEffectResult = <T>(
  result:
    | { readonly _tag: "Success"; readonly success: T }
    | { readonly _tag: "Failure"; readonly failure: unknown },
): Promise<T> =>
  result._tag === "Failure" ? Promise.reject(result.failure) : Promise.resolve(result.success);

export const jsonErrorResponse = (error: string, status: number): Response =>
  new Response(JSON.stringify({ error }), { status });

export const errorTagFromCause = (cause: unknown, fallback: string): string =>
  cause !== null && typeof cause === "object" && "_tag" in cause
    ? String((cause as { readonly _tag: unknown })._tag)
    : fallback;

export const invalidResourceAmount = (amount: number): InvalidResourceAmount | null =>
  Number.isFinite(amount) && amount > 0 ? null : new InvalidResourceAmount({ amount });

export type CoreServices =
  | CloudflareBackendCoreServices
  | LlmTransport
  | Admission
  | RefResolverService;

export const makeAgentRuntime = <Env extends CloudflareAgentEnv>(
  ctx: DurableObjectState,
  env: Env,
  scope: string,
  identity: BackendProtocolEventIdentity,
  handlers: Map<string, Set<EventHandler>>,
  refs: RefResolver,
  llmTransport: Layer.Layer<LlmTransport, never, RefResolverService>,
  dispatchTargets: DispatchTargetRegistry,
  appTriggers: CloudflareTriggerSource<Env>,
  appStreams: CloudflareAttachedStreamSource<Env>,
  appProjections: ReadonlyArray<AnyMaterializedProjectionDefinition>,
): ManagedRuntime.ManagedRuntime<
  CoreServices,
  SqlError | TriggerFactoryError | RuntimeStorageError
> => {
  const backendCoreLayer = makeCloudflareBackendCoreLayer(
    ctx,
    env,
    scope,
    identity,
    handlers,
    dispatchTargets,
    appTriggers,
    appStreams,
    appProjections,
  );
  const refResolverLayer = RefResolverLive(refs);
  const llmTransportLayer = llmTransport.pipe(Layer.provide(refResolverLayer));
  const admissionLayer = AdmissionLive(ctx, identity).pipe(
    Layer.provide(Layer.mergeAll(backendCoreLayer, llmTransportLayer)),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(backendCoreLayer, llmTransportLayer, admissionLayer, refResolverLayer),
  );
};

export const rejectAgentConfig = (message: string): never =>
  Option.getOrThrowWith(Option.none(), () => new TypeError(message));

export const declaredToolIntents = (
  extensions: ReadonlyArray<ExtensionDeclaration>,
  declaredIntents: ReadonlyArray<AgentDeclaredIntent>,
): ReadonlyArray<SubmitToolIntent> => {
  const boundaryPackages = new Map<string, BoundaryPackage>();
  for (const extension of extensions) {
    if (isBoundaryPackage(extension)) {
      boundaryPackages.set(extension.ownerId, extension);
    }
  }

  return declaredIntents.map((intent) => {
    const boundaryPackage = boundaryPackages.get(intent.boundaryOwnerId);
    if (boundaryPackage === undefined) {
      return rejectAgentConfig(`declared intent ${intent.kind} references unbound boundary owner`);
    }
    if (!extensionOwnsEvent(boundaryPackage, intent.kind)) {
      return rejectAgentConfig(
        `declared intent ${intent.kind} is not owned by ${intent.boundaryOwnerId}`,
      );
    }
    return {
      kind: intent.kind,
      boundaryPackage,
    };
  });
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
