/**
 * Host-neutral workspace operation install helpers.
 */

import { Effect, Predicate, Schema } from "effect";
import type { EventHandler, LedgerEventRpc } from "@agent-os/core/types";
import type { BoundaryModule } from "@agent-os/core/boundary-contract";
import type { ToolAdmitter } from "@agent-os/core/tools";
import {
  capabilityIntent,
  capabilityMaterial,
  capabilityProjection,
  type AgentSubmitBindings,
  type AnyAgentCapabilityDefinition,
} from "@agent-os/core/runtime-protocol";
import {
  defineProjection,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
  projectionSkip,
  type AnyMaterializedProjectionDefinition,
} from "../projection";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
  projectWorkspaceOperation,
  workspaceOpBoundaryModule,
  workspaceOpCarrier,
  type WorkspaceOperationProjection,
  type WorkspaceOperationRequestedPayload,
} from "../workspace-op-carrier";
import {
  bindWorkspaceToolsForRuntime,
  type BindWorkspaceToolsForRuntimeOptions,
  type WorkspaceToolExposurePolicy,
} from "../workspace-binding";
import type { CreateWorkspaceOperationLocalProviderOptions } from "../workspace-op-local";
import { defineCapability } from "./contract";
import type { CapabilityInstallContext } from "./contract";
import type { CapabilityCommitInput } from "./install-context";
import { WORKSPACE_OPERATION_HOST_FACT } from "./materialized-host-facts";
import {
  createWorkspaceOperationEventHandler,
  resolveWorkspaceOperationBindingEnv,
  workspaceOperationEnvResolverFromHost,
} from "./workspace-operations-host-adapter";

export { WORKSPACE_OPERATION_HOST_FACT } from "./materialized-host-facts";

type WorkspaceEnv = CreateWorkspaceOperationLocalProviderOptions["env"];

export interface WorkspaceOperationBindingEnvResolverInput {
  readonly mode: "binding";
}

export interface WorkspaceOperationRequestedEnvResolverInput {
  readonly mode: "operation";
  readonly event: LedgerEventRpc;
  readonly payload: WorkspaceOperationRequestedPayload;
  readonly workspaceRef: string;
  readonly runId?: string;
}

export type WorkspaceOperationEnvResolverInput =
  | WorkspaceOperationBindingEnvResolverInput
  | WorkspaceOperationRequestedEnvResolverInput;

export type WorkspaceOperationEnvResolver = (
  input: WorkspaceOperationEnvResolverInput,
) => WorkspaceEnv | Promise<WorkspaceEnv>;

export type WorkspaceOperationHostFacts = {
  readonly [WORKSPACE_OPERATION_HOST_FACT]: WorkspaceOperationEnvResolver;
};

export interface WorkspaceOperationsOptions
  extends Omit<CreateWorkspaceOperationLocalProviderOptions, "env">, WorkspaceToolExposurePolicy {
  readonly boundaryVersion?: string;
  readonly authority?: string;
  readonly authorityId?: string;
  readonly authorityVersion?: string;
  readonly admit?: ToolAdmitter<unknown>;
  readonly workspaceMaterialRef?: BindWorkspaceToolsForRuntimeOptions["workspaceMaterialRef"];
  readonly toolContext?: BindWorkspaceToolsForRuntimeOptions["toolContext"];
  readonly toolIntents?: BindWorkspaceToolsForRuntimeOptions["toolIntents"];
  readonly hooks?: BindWorkspaceToolsForRuntimeOptions["hooks"];
}

export interface WorkspaceOperationInstallContext {
  readonly capabilities: ReadonlyMap<
    string,
    {
      readonly commit: (input: CapabilityCommitInput) => Promise<unknown>;
    }
  >;
}

export interface WorkspaceOperationInstall {
  readonly extensions: ReadonlyArray<BoundaryModule>;
  readonly capabilities: Readonly<Record<string, AnyAgentCapabilityDefinition>>;
  readonly declaredIntents: ReadonlyArray<{
    readonly kind: string;
    readonly boundaryOwnerId: string;
  }>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly bindings?: AgentSubmitBindings;
  readonly eventHandlers: (
    context: WorkspaceOperationInstallContext,
  ) => Iterable<{ readonly kind: string; readonly handler: EventHandler }>;
}

const DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION = "0.2.9";
const WORKSPACE_OPERATIONS_CAPABILITY_BINDING_REF = WORKSPACE_OP_FACT_OWNER;

const allowWorkspaceTool: ToolAdmitter<unknown> = () => Effect.succeed({ ok: true as const });

const workspaceOperationsAgentCapability = (
  boundaryModule: BoundaryModule,
): AnyAgentCapabilityDefinition => ({
  id: WORKSPACE_OP_FACT_OWNER,
  boundaryModule,
  intents: {
    requested: capabilityIntent<WorkspaceOperationRequestedPayload>()(WORKSPACE_OP_KIND.REQUESTED, {
      boundaryModule,
    }),
  },
  projections: {
    operation: capabilityProjection<
      { readonly requestedEventId: number },
      WorkspaceOperationProjection
    >()(WORKSPACE_OP_PROJECTION_KIND, {
      factOwnerRef: WORKSPACE_OP_FACT_OWNER,
    }),
  },
  materials: {
    workspace: capabilityMaterial<WorkspaceEnv>()("workspace"),
  },
});

const workspaceOperationProjectionState = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("missing"),
    requestedEventId: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("requested"),
    requestedEventId: Schema.Number,
    request: Schema.Unknown,
  }),
  Schema.Struct({
    status: Schema.Literal("completed"),
    requestedEventId: Schema.Number,
    request: Schema.Unknown,
    completed: Schema.Unknown,
    result: Schema.Unknown,
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    requestedEventId: Schema.Number,
    request: Schema.Unknown,
    rejected: Schema.Unknown,
  }),
]) as Schema.Codec<WorkspaceOperationProjection, unknown, never, never>;

const requestEventFor = (
  state: WorkspaceOperationProjection,
): { readonly id: number; readonly kind: string; readonly payload: unknown } | null =>
  state.status === "missing"
    ? null
    : {
        id: state.requestedEventId,
        kind: WORKSPACE_OP_KIND.REQUESTED,
        payload: state.request,
      };

const isTerminalState = (
  state: WorkspaceOperationProjection,
): state is Extract<WorkspaceOperationProjection, { readonly status: "completed" | "rejected" }> =>
  state.status === "completed" || state.status === "rejected";

/** @internal */
export const workspaceOperationMaterializedProjection = (): AnyMaterializedProjectionDefinition =>
  defineProjection<{ readonly requestedEventId: number }, WorkspaceOperationProjection>({
    kind: WORKSPACE_OP_PROJECTION_KIND,
    version: 1,
    eventKinds: [
      WORKSPACE_OP_KIND.REQUESTED,
      WORKSPACE_OP_KIND.COMPLETED,
      WORKSPACE_OP_KIND.REJECTED,
    ],
    identity: Schema.Struct({ requestedEventId: Schema.Number }),
    state: workspaceOperationProjectionState,
    identityKey: (identity) => String(identity.requestedEventId),
    identify: (event) => {
      if (event.factOwnerRef !== WORKSPACE_OP_FACT_OWNER) return projectionSkip();
      if (event.kind === WORKSPACE_OP_KIND.REQUESTED) {
        return projectionIdentity({ requestedEventId: event.id });
      }
      if (event.kind !== WORKSPACE_OP_KIND.COMPLETED && event.kind !== WORKSPACE_OP_KIND.REJECTED) {
        return projectionSkip();
      }
      if (!Predicate.isObject(event.payload)) {
        return projectionMalformed("workspace_op terminal payload must be an object");
      }
      return typeof event.payload.requestedEventId === "number"
        ? projectionIdentity({ requestedEventId: event.payload.requestedEventId })
        : projectionMalformed("workspace_op terminal payload requires requestedEventId");
    },
    initial: (identity, event) => projectWorkspaceOperation([event], identity.requestedEventId),
    reduce: (state, event) => {
      if (isTerminalState(state)) return projectionPut(state);
      if (event.kind === WORKSPACE_OP_KIND.REQUESTED) {
        return projectionPut(projectWorkspaceOperation([event], event.id));
      }
      const request = requestEventFor(state);
      if (request === null) return projectionPut(state);
      return projectionPut(projectWorkspaceOperation([request, event], state.requestedEventId));
    },
  });

/** @internal */
export const createWorkspaceOperationInstall = (
  options: WorkspaceOperationsOptions,
  envResolver: WorkspaceOperationEnvResolver,
): WorkspaceOperationInstall => {
  const boundaryModule = workspaceOpBoundaryModule(
    options.boundaryVersion ?? DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION,
  );
  const toolBindingsRequested =
    (options.toolNames !== undefined && options.toolNames.length > 0) ||
    options.exposure !== undefined;
  const bindings = (): BindWorkspaceToolsForRuntimeOptions | undefined => {
    if (!toolBindingsRequested) return undefined;
    const env = resolveWorkspaceOperationBindingEnv(envResolver);
    return {
      env,
      authority: options.authority ?? "agentos.workspace.capability",
      admit: options.admit ?? allowWorkspaceTool,
      ...(options.authorityId === undefined ? {} : { authorityId: options.authorityId }),
      ...(options.authorityVersion === undefined
        ? {}
        : { authorityVersion: options.authorityVersion }),
      ...(options.workspaceMaterialRef === undefined
        ? {}
        : { workspaceMaterialRef: options.workspaceMaterialRef }),
      ...(options.toolContext === undefined ? {} : { toolContext: options.toolContext }),
      ...(options.toolIntents === undefined ? {} : { toolIntents: options.toolIntents }),
      ...(options.toolNames === undefined ? {} : { toolNames: options.toolNames }),
      ...(options.exposure === undefined ? {} : { exposure: options.exposure }),
      ...(options.mutationPolicy === undefined ? {} : { mutationPolicy: options.mutationPolicy }),
      ...(options.shellPolicy === undefined ? {} : { shellPolicy: options.shellPolicy }),
      ...(options.toolInteractions === undefined
        ? {}
        : { toolInteractions: options.toolInteractions }),
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxCommandChars === undefined
        ? {}
        : { maxCommandChars: options.maxCommandChars }),
      ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    };
  };

  return {
    extensions: [boundaryModule],
    capabilities: {
      [WORKSPACE_OPERATIONS_CAPABILITY_BINDING_REF]:
        workspaceOperationsAgentCapability(boundaryModule),
    },
    declaredIntents: [
      {
        kind: WORKSPACE_OP_KIND.REQUESTED,
        boundaryOwnerId: boundaryModule.manifest.ownerId,
      },
    ],
    projections: [workspaceOperationMaterializedProjection()],
    ...(toolBindingsRequested ? { bindings: bindWorkspaceToolsForRuntime(bindings()!) } : {}),
    eventHandlers: (context) => [
      {
        kind: WORKSPACE_OP_KIND.REQUESTED,
        handler: createWorkspaceOperationEventHandler(options, envResolver, context),
      },
    ],
  };
};

/**
 * Workspace operations capability
 * @public
 */
export const workspaceOperations = (options: WorkspaceOperationsOptions) =>
  defineCapability({
    capabilityId: WORKSPACE_OP_FACT_OWNER,
    carrier: workspaceOpCarrier,
    requires: {
      hostFacts: [WORKSPACE_OPERATION_HOST_FACT],
    },
    install: (ctx: CapabilityInstallContext) => {
      const install = createWorkspaceOperationInstall(
        options,
        workspaceOperationEnvResolverFromHost(ctx.host),
      );
      return {
        extensions: install.extensions,
        capabilities: install.capabilities,
        declaredIntents: install.declaredIntents,
        projections: install.projections,
        bindings: install.bindings,
        eventHandlers: (handlerCtx) => [...install.eventHandlers(handlerCtx)],
      };
    },
  });
