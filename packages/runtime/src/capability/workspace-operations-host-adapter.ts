import { Option } from "effect";
import { CapabilityRejected } from "@agent-os/core/errors";
import type { EventHandler, LedgerEventRpc } from "@agent-os/core/types";
import {
  WORKSPACE_OP_AUTHORITY_CONTRACT,
  WORKSPACE_OP_FACT_OWNER,
  WORKSPACE_OP_KIND,
  type WorkspaceOperationRequestedPayload,
} from "../workspace-op-carrier";
import {
  createWorkspaceOperationLocalProvider,
  type CreateWorkspaceOperationLocalProviderOptions,
  type WorkspaceOperationLocalProvider,
} from "../workspace-op-local";
import { WORKSPACE_OPERATION_HOST_FACT } from "./materialized-host-facts";
import type { CapabilityInstallContext } from "./contract";
import type {
  WorkspaceOperationEnvResolver,
  WorkspaceOperationInstallContext,
  WorkspaceOperationsOptions,
} from "./workspace-operations";

type WorkspaceEnv = CreateWorkspaceOperationLocalProviderOptions["env"];

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

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

export const workspaceOperationEnvResolverFromHost = (
  host: CapabilityInstallContext["host"],
): WorkspaceOperationEnvResolver => {
  const resolver = host[WORKSPACE_OPERATION_HOST_FACT];
  if (typeof resolver !== "function") {
    throw new TypeError(
      `host fact ${WORKSPACE_OPERATION_HOST_FACT} must materialize a WorkspaceOperationEnvResolver`,
    );
  }
  return resolver as WorkspaceOperationEnvResolver;
};

export const resolveWorkspaceOperationBindingEnv = (
  envResolver: WorkspaceOperationEnvResolver,
): WorkspaceEnv => {
  const env = envResolver({ mode: "binding" });
  if (isThenable(env)) {
    throw new TypeError(
      "workspaceOperations tool bindings require a synchronous fs.workspace resolver",
    );
  }
  return env;
};

export const createWorkspaceOperationEventHandler = (
  options: WorkspaceOperationsOptions,
  envResolver: WorkspaceOperationEnvResolver,
  context: WorkspaceOperationInstallContext,
): EventHandler => {
  const providers = new Map<string, WorkspaceOperationLocalProvider>();
  const providerFor = async (
    event: LedgerEventRpc,
    payload: WorkspaceOperationRequestedPayload,
  ): Promise<WorkspaceOperationLocalProvider> => {
    const runId = runIdFromRequest(payload);
    const key = `${payload.workspaceRef}\0${runId ?? ""}`;
    const existing = providers.get(key);
    if (existing !== undefined) return existing;
    const env = await envResolver({
      mode: "operation",
      event,
      payload,
      workspaceRef: payload.workspaceRef,
      ...(runId === undefined ? {} : { runId }),
    });
    const provider = createWorkspaceOperationLocalProvider(providerOptions(options, env));
    providers.set(key, provider);
    return provider;
  };

  return async (event: LedgerEventRpc) => {
    const request = requestedPayload(event);
    if (request === null) return;
    const provider = await providerFor(event, request);
    const result = await provider.execute({ id: event.id, payload: request });
    const capability = workspaceOpCapability(context.capabilities);
    await capability.commit({
      event: result.ok ? WORKSPACE_OP_KIND.COMPLETED : WORKSPACE_OP_KIND.REJECTED,
      data: result.payload,
      authorityBinding: {
        authorityContractId: WORKSPACE_OP_AUTHORITY_CONTRACT,
        expectedAuthorityRef: event.effectAuthorityRef,
      },
    });
  };
};
