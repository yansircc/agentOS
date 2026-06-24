/**
 * Host-neutral workspace operation install helpers.
 */

import { Option, Predicate, Schema } from "effect";
import { CapabilityRejected, type EventHandler, type LedgerEventRpc } from "@agent-os/core";
import type { ExtensionDeclaration } from "@agent-os/core/extensions";
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
  workspaceOpBoundaryPackage,
  workspaceOpCarrier,
  type WorkspaceOperationProjection,
  type WorkspaceOperationRequestedPayload,
} from "../workspace-op-carrier";
import {
  createWorkspaceOperationLocalProvider,
  type CreateWorkspaceOperationLocalProviderOptions,
  type WorkspaceOperationLocalProvider,
} from "../workspace-op-local";
import { defineCapability } from "./contract";
import type { CapabilityInstallContext } from "./contract";

type WorkspaceEnv = CreateWorkspaceOperationLocalProviderOptions["env"];

export interface WorkspaceOperationEnvResolverInput {
  readonly event: LedgerEventRpc;
  readonly payload: WorkspaceOperationRequestedPayload;
  readonly workspaceRef: string;
  readonly runId?: string;
}

export type WorkspaceOperationEnvResolver = (
  input: WorkspaceOperationEnvResolverInput,
) => WorkspaceEnv | Promise<WorkspaceEnv>;

export interface WorkspaceOperationsOptions extends Omit<
  CreateWorkspaceOperationLocalProviderOptions,
  "env"
> {
  readonly env: WorkspaceEnv | WorkspaceOperationEnvResolver;
  readonly boundaryVersion?: string;
}

export interface WorkspaceOperationInstallContext {
  readonly capabilities: ReadonlyMap<
    string,
    {
      readonly commit: (input: {
        readonly event: string;
        readonly data: unknown;
      }) => Promise<unknown>;
    }
  >;
}

export interface WorkspaceOperationInstall {
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents: ReadonlyArray<{
    readonly kind: string;
    readonly boundaryOwnerId: string;
  }>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly eventHandlers: (
    context: WorkspaceOperationInstallContext,
  ) => Iterable<{ readonly kind: string; readonly handler: EventHandler }>;
}

const DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION = "0.2.9";

const requestedPayload = (event: LedgerEventRpc): WorkspaceOperationRequestedPayload | null =>
  event.kind === WORKSPACE_OP_KIND.REQUESTED &&
  event.factOwnerRef === WORKSPACE_OP_FACT_OWNER &&
  event.payload !== null &&
  typeof event.payload === "object"
    ? (event.payload as WorkspaceOperationRequestedPayload)
    : null;

const workspaceOpCapability = (capabilities: WorkspaceOperationInstallContext["capabilities"]) => {
  const capability = capabilities.get(WORKSPACE_OP_FACT_OWNER);
  return Option.getOrThrowWith(
    Option.fromNullishOr(capability),
    () =>
      new CapabilityRejected({
        event: WORKSPACE_OP_KIND.COMPLETED,
        capability: `extension:${WORKSPACE_OP_FACT_OWNER}`,
      }),
  );
};

const runIdFromRequest = (request: WorkspaceOperationRequestedPayload): string | undefined => {
  const origin = request.claim.originRef;
  if (origin.originKind !== "submit" && origin.originKind !== "run") return undefined;
  return origin.originId.startsWith("run:") ? origin.originId.slice(4) : origin.originId;
};

const isEnvResolver = (
  env: WorkspaceOperationsOptions["env"],
): env is WorkspaceOperationEnvResolver => typeof env === "function";

const providerOptions = (
  options: WorkspaceOperationsOptions,
  env: WorkspaceEnv,
): CreateWorkspaceOperationLocalProviderOptions => ({
  env,
  ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  ...(options.maxCommandChars === undefined ? {} : { maxCommandChars: options.maxCommandChars }),
  ...(options.execTimeoutMs === undefined ? {} : { execTimeoutMs: options.execTimeoutMs }),
  ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
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
): WorkspaceOperationInstall => {
  const boundaryPackage = workspaceOpBoundaryPackage(
    options.boundaryVersion ?? DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION,
  );
  const providers = new Map<string, WorkspaceOperationLocalProvider>();
  const providerFor = async (
    event: LedgerEventRpc,
    payload: WorkspaceOperationRequestedPayload,
  ): Promise<WorkspaceOperationLocalProvider> => {
    const runId = runIdFromRequest(payload);
    const key = `${payload.workspaceRef}\0${runId ?? ""}`;
    const existing = providers.get(key);
    if (existing !== undefined) return existing;
    const env = isEnvResolver(options.env)
      ? await options.env({
          event,
          payload,
          workspaceRef: payload.workspaceRef,
          ...(runId === undefined ? {} : { runId }),
        })
      : options.env;
    const provider = createWorkspaceOperationLocalProvider(providerOptions(options, env));
    providers.set(key, provider);
    return provider;
  };

  return {
    extensions: [boundaryPackage],
    declaredIntents: [
      {
        kind: WORKSPACE_OP_KIND.REQUESTED,
        boundaryOwnerId: boundaryPackage.ownerId,
      },
    ],
    projections: [workspaceOperationMaterializedProjection()],
    eventHandlers: (context) => [
      {
        kind: WORKSPACE_OP_KIND.REQUESTED,
        handler: (async (event: LedgerEventRpc) => {
          const request = requestedPayload(event);
          if (request === null) return;
          const provider = await providerFor(event, request);
          const result = await provider.execute({ id: event.id, payload: request });
          const capability = workspaceOpCapability(context.capabilities);
          await capability.commit({
            event: result.ok ? WORKSPACE_OP_KIND.COMPLETED : WORKSPACE_OP_KIND.REJECTED,
            data: result.payload,
          });
        }) as EventHandler,
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
      hostFacts: ["fs.workspace"],
    },
    install: (ctx: CapabilityInstallContext) => {
      const install = createWorkspaceOperationInstall(options);
      return {
        extensions: install.extensions,
        declaredIntents: install.declaredIntents,
        projections: install.projections,
        eventHandlers: () => [...install.eventHandlers({ capabilities: ctx.capabilities })],
      };
    },
  });
