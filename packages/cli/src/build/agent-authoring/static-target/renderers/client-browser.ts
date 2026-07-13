import { renderNamedImport, renderTypeImport, staticTargetModules } from "../encoding";
import {
  generatedCommandInputTypesForProfile,
  renderGeneratedClientMethods,
  renderGeneratedClientTypeMethods,
} from "../../generated-command-projection";

export const renderWorkspaceBrowserDirectClient = (
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["createWorkspaceAgentClientBridge"], modules.workspaceAgentClient)}
${renderNamedImport(["createAgentSession"], modules.productShellClient)}
${renderTypeImport(["AgentSession"], modules.productShellClient)}
${renderTypeImport(
  [
    "AgentSessionListProjection",
    "AgentSessionProjection",
    "WorkflowRunListProjection",
    "WorkflowRunProjection",
  ],
  modules.runtimeRunProjector,
)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClientBridge",
    "WorkspaceAgentProductCommandMap",
    "WorkspaceAgentProductProjectionTypes",
  ],
  modules.workspaceAgentClient,
)}

export interface GeneratedAgentClientProductProjections extends WorkspaceAgentProductProjectionTypes {
  readonly session: AgentSessionProjection;
  readonly sessionList: AgentSessionListProjection;
  readonly workflowRun: WorkflowRunProjection;
  readonly workflowRunList: WorkflowRunListProjection;
}

export type GeneratedAgentClientOptions =
  CreateWorkspaceAgentClientOptions<WorkspaceAgentProductCommandMap<GeneratedAgentClientProductProjections>>;
export interface GeneratedAgentClient
  extends WorkspaceAgentClientBridge<GeneratedAgentClientProductProjections> {
  readonly session: AgentSession;
}

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const bridge = createWorkspaceAgentClientBridge(options);
  return {
    ...bridge,
    session: createAgentSession({ submitTurn: bridge.sessions.submitTurn }),
  };
};
`;

export const renderWorkspaceSvelteKitClient = (
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["createWorkspaceAgentClientBridge"], modules.workspaceAgentClient)}
${renderNamedImport(["createAgentSession"], modules.productShellClient)}
${renderTypeImport(["AgentSession"], modules.productShellClient)}
import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";
${renderNamedImport(["clientReadable", "selectClientReadable"], modules.clientSvelte)}
${renderTypeImport(["AgentClientSnapshot"], modules.clientCore)}
${renderTypeImport(
  [
    "AgentSessionListProjection",
    "AgentSessionProjection",
    "WorkflowRunListProjection",
    "WorkflowRunProjection",
  ],
  modules.runtimeRunProjector,
)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClientBridge",
    "WorkspaceAgentProductClient",
    "WorkspaceAgentProductCommandMap",
    "WorkspaceAgentProductProjectionTypes",
  ],
  modules.workspaceAgentClient,
)}
${renderTypeImport(["Readable"], modules.svelteStore)}

export interface GeneratedAgentClientProductProjections extends WorkspaceAgentProductProjectionTypes {
  readonly session: AgentSessionProjection;
  readonly sessionList: AgentSessionListProjection;
  readonly workflowRun: WorkflowRunProjection;
  readonly workflowRunList: WorkflowRunListProjection;
}

export type GeneratedAgentClientOptions =
  CreateWorkspaceAgentClientOptions<WorkspaceAgentProductCommandMap<GeneratedAgentClientProductProjections>>;

export interface GeneratedAgentClient
  extends WorkspaceAgentClientBridge<GeneratedAgentClientProductProjections> {
  readonly session: AgentSession;
  readonly snapshot: Readable<AgentClientSnapshot>;
  readonly events: Readable<AgentClientSnapshot["events"]>;
  readonly connection: Readable<AgentClientSnapshot["connection"]>;
  readonly run: Readable<AgentClientSnapshot["run"]>;
  readonly inputRequests: Readable<AgentClientSnapshot["run"]["inputRequests"]>;
}

const generatedStreamSource: NonNullable<GeneratedAgentClientOptions["streamSource"]> = {
  open: (cursor) =>
    runEventStream({
      ...(cursor.afterEventId === undefined ? {} : { afterId: cursor.afterEventId }),
    }),
};

const generatedRpcInvoker = ((name, input) =>
  invokeAgentCommand({ name, input })) as WorkspaceAgentProductClient<
  GeneratedAgentClientProductProjections
>["invoke"];

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const bridge = createWorkspaceAgentClientBridge({
    ...options,
    streamSource: options.streamSource ?? generatedStreamSource,
    rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker,
  });
  return {
    ...bridge,
    session: createAgentSession({ submitTurn: bridge.sessions.submitTurn }),
    snapshot: clientReadable(bridge.client),
    events: selectClientReadable(bridge.client, (snapshot) => snapshot.events),
    connection: selectClientReadable(bridge.client, (snapshot) => snapshot.connection),
    run: selectClientReadable(bridge.client, (snapshot) => snapshot.run),
    inputRequests: selectClientReadable(bridge.client, (snapshot) => snapshot.run.inputRequests),
  };
};
`;

export const chatStaticClientFragments = (
  modules: ReturnType<typeof staticTargetModules>,
): {
  readonly commonImports: string;
  readonly commonTypes: string;
  readonly commonMethods: string;
} => {
  const commonImports = `${renderNamedImport(
    ["WORKSPACE_AGENT_COMMAND", "createWorkspaceAgentClient"],
    modules.workspaceAgentClient,
  )}
${renderTypeImport(["SubmitRunInput"], modules.runtimeProtocol)}
${renderTypeImport(["AgentClientCommandOptions", "AgentClientSnapshot"], modules.clientCore)}
${renderTypeImport(
  [
    "CreateWorkspaceAgentClientOptions",
    "WorkspaceAgentClient",
    "WorkspaceAgentCommandOutputByName",
    ...generatedCommandInputTypesForProfile("chat"),
  ],
  modules.workspaceAgentClient,
)}`;
  const commonTypes = `
export type GeneratedAgentClientOptions = CreateWorkspaceAgentClientOptions;

export interface GeneratedAgentClient {
  readonly client: WorkspaceAgentClient;
${renderGeneratedClientTypeMethods("chat")}
`;
  const commonMethods = `
    client,
${renderGeneratedClientMethods("chat")}`;
  return { commonImports, commonTypes, commonMethods };
};

export const renderChatBrowserDirectClient = (
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const { commonImports, commonTypes, commonMethods } = chatStaticClientFragments(modules);
  return `${commonImports}
${commonTypes}
}

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const client = createWorkspaceAgentClient(options);
  return {${commonMethods}
  };
};
`;
};

export const renderChatSvelteKitClient = (
  modules: ReturnType<typeof staticTargetModules>,
): string => {
  const { commonImports, commonTypes, commonMethods } = chatStaticClientFragments(modules);
  return `${commonImports}
import { invokeAgentCommand, runEventStream } from "./sveltekit.remote";
${renderNamedImport(["clientReadable", "selectClientReadable"], modules.clientSvelte)}
${renderTypeImport(["Readable"], modules.svelteStore)}
${commonTypes}
  readonly snapshot: Readable<AgentClientSnapshot>;
  readonly events: Readable<AgentClientSnapshot["events"]>;
  readonly connection: Readable<AgentClientSnapshot["connection"]>;
  readonly run: Readable<AgentClientSnapshot["run"]>;
  readonly inputRequests: Readable<AgentClientSnapshot["run"]["inputRequests"]>;
}

const generatedStreamSource: NonNullable<GeneratedAgentClientOptions["streamSource"]> = {
  open: (cursor) =>
    runEventStream({
      ...(cursor.afterEventId === undefined ? {} : { afterId: cursor.afterEventId }),
    }),
};

const generatedRpcInvoker: WorkspaceAgentClient["invoke"] = (name, input) =>
  invokeAgentCommand({ name, input }) as Promise<WorkspaceAgentCommandOutputByName[typeof name]>;

export const createAgentOSClient = (
  options: GeneratedAgentClientOptions = {},
): GeneratedAgentClient => {
  const client = createWorkspaceAgentClient({
    ...options,
    streamSource: options.streamSource ?? generatedStreamSource,
    rpcInvoker: options.rpcInvoker ?? generatedRpcInvoker,
  });
  return {${commonMethods}
    snapshot: clientReadable(client),
    events: selectClientReadable(client, (snapshot) => snapshot.events),
    connection: selectClientReadable(client, (snapshot) => snapshot.connection),
    run: selectClientReadable(client, (snapshot) => snapshot.run),
    inputRequests: selectClientReadable(client, (snapshot) => snapshot.run.inputRequests),
  };
};
`;
};

export const renderStaticClientTypes = (): string => `export type {
  GeneratedAgentClient,
  GeneratedAgentClientOptions,
} from "./client";

export { createAgentOSClient } from "./client";
`;
