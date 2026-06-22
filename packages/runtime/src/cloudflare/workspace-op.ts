import { Option, Predicate, Schema } from "effect";
import { CapabilityRejected, type EventHandler, type LedgerEventRpc } from "@agent-os/core";
import type { ExtensionCapability, ExtensionDeclaration } from "@agent-os/core/extensions";
import {
  defineProjection,
  projectionIdentity,
  projectionMalformed,
  projectionPut,
  projectionSkip,
  type AnyMaterializedProjectionDefinition,
} from "@agent-os/runtime";
import {
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  WORKSPACE_OP_PROJECTION_KIND,
  projectWorkspaceOperation,
  workspaceOpBoundaryPackage,
  type WorkspaceOperationRequestedPayload,
  type WorkspaceOperationProjection,
} from "../workspace-op-carrier";
import {
  createWorkspaceOperationLocalProvider,
  type CreateWorkspaceOperationLocalProviderOptions,
  type WorkspaceOperationLocalProvider,
} from "../workspace-op-local";

export interface CloudflareWorkspaceOperationInstallContext {
  readonly capabilities: ReadonlyMap<string, ExtensionCapability>;
}

export interface CloudflareWorkspaceOperationProviderHandlers {
  readonly eventHandlers: (
    context: CloudflareWorkspaceOperationInstallContext,
  ) => Iterable<{ readonly kind: string; readonly handler: EventHandler }>;
}

export interface CloudflareWorkspaceOperationInstall {
  readonly extensions: ReadonlyArray<ExtensionDeclaration>;
  readonly declaredIntents: ReadonlyArray<{
    readonly kind: string;
    readonly boundaryOwnerId: string;
  }>;
  readonly projections: ReadonlyArray<AnyMaterializedProjectionDefinition>;
  readonly eventHandlers: CloudflareWorkspaceOperationProviderHandlers["eventHandlers"];
}

type WorkspaceEnv = CreateWorkspaceOperationLocalProviderOptions["env"];

export interface CloudflareWorkspaceOperationEnvResolverInput {
  readonly event: LedgerEventRpc;
  readonly payload: WorkspaceOperationRequestedPayload;
  readonly workspaceRef: string;
  readonly runId?: string;
}

export type CloudflareWorkspaceOperationEnvResolver = (
  input: CloudflareWorkspaceOperationEnvResolverInput,
) => WorkspaceEnv | Promise<WorkspaceEnv>;

export type InstallCloudflareWorkspaceOperationProviderOptions = Omit<
  CreateWorkspaceOperationLocalProviderOptions,
  "env"
> & {
  readonly env: WorkspaceEnv | CloudflareWorkspaceOperationEnvResolver;
  readonly boundaryVersion?: string;
};

const DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION = "0.2.9";

const requestedPayload = (event: LedgerEventRpc): WorkspaceOperationRequestedPayload | null =>
  event.kind === WORKSPACE_OP_KIND.REQUESTED &&
  event.factOwnerRef === WORKSPACE_OP_FACT_OWNER &&
  event.payload !== null &&
  typeof event.payload === "object"
    ? (event.payload as WorkspaceOperationRequestedPayload)
    : null;

const workspaceOpCapability = (
  capabilities: ReadonlyMap<string, ExtensionCapability>,
): ExtensionCapability => {
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
  env: InstallCloudflareWorkspaceOperationProviderOptions["env"],
): env is CloudflareWorkspaceOperationEnvResolver => typeof env === "function";

const providerOptions = (
  options: InstallCloudflareWorkspaceOperationProviderOptions,
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

const workspaceOperationMaterializedProjection = (): AnyMaterializedProjectionDefinition =>
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

/**
 * Installs workspace-op provider glue for Cloudflare DO hosts.
 *
 * Products still declare the WorkspaceEnv and tool exposure policy. This
 * helper owns the host-side reducer/provider commit loop: requested facts are
 * executed by the local provider and completed/rejected facts are committed
 * only through the workspace-op boundary capability.
 *
 * @agentosPrimitive primitive.cloudflare-do.installCloudflareWorkspaceOperationProvider
 * @agentosInvariant invariant.workspace-op.carrier-single-writer
 * @agentosDocs docs/packages/runtime.md
 * @public
 */
export const installCloudflareWorkspaceOperationProvider = (
  options: InstallCloudflareWorkspaceOperationProviderOptions,
): CloudflareWorkspaceOperationInstall => {
  const boundaryPackage = workspaceOpBoundaryPackage(
    options.boundaryVersion ?? DEFAULT_WORKSPACE_OP_BOUNDARY_VERSION,
  );
  const providers = new Map<string, WorkspaceOperationLocalProvider>();
  const providerFor = async (
    event: LedgerEventRpc,
    payload: WorkspaceOperationRequestedPayload,
  ): Promise<WorkspaceOperationLocalProvider> => {
    const runId = runIdFromRequest(payload);
    const key = `${payload.workspaceRef}\u0000${runId ?? ""}`;
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
        handler: async (event) => {
          const request = requestedPayload(event);
          if (request === null) return;
          const provider = await providerFor(event, request);
          const result = await provider.execute({ id: event.id, payload: request });
          const capability = workspaceOpCapability(context.capabilities);
          await capability.commit({
            event: result.ok ? WORKSPACE_OP_KIND.COMPLETED : WORKSPACE_OP_KIND.REJECTED,
            data: result.payload,
          });
        },
      },
    ],
  };
};
