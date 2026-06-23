import type { RuntimeLedgerEvent, SubmitRunInput } from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_AGENT_COMMAND,
  type WorkspaceAgentCommandInputByName,
  type WorkspaceAgentCommandOutputByName,
  type WorkspaceAgentCustomCommandInput,
  type WorkspaceAgentDecideInputRequestCommandInput,
  type WorkspaceAgentDestroyCommandInput,
  type WorkspaceAgentMutationCommandOutput,
  type WorkspaceAgentReadFileCommandInput,
  type WorkspaceAgentReadFileCommandOutput,
  type WorkspaceAgentReadStateCommandInput,
  type WorkspaceAgentReadStateCommandOutput,
  type WorkspaceAgentResetCommandInput,
  type WorkspaceAgentResumeInputRequestCommandInput,
} from "@agent-os/core/workspace-agent";
import {
  createAgentClient,
  type AgentClientCommandOptions,
  type AgentClientCommandSpec,
  type AgentClientController,
  type AgentClientStreamSource,
} from "./index";

export type {
  WorkspaceAgentCommandInputByName,
  WorkspaceAgentCommandName,
  WorkspaceAgentCommandOutputByName,
  WorkspaceAgentCustomCommandInput,
  WorkspaceAgentDecideInputRequestCommandInput,
  WorkspaceAgentDestroyCommandInput,
  WorkspaceAgentFileEntry,
  WorkspaceAgentMutationCommandOutput,
  WorkspaceAgentProjectionName,
  WorkspaceAgentReadFileCommandInput,
  WorkspaceAgentReadFileCommandOutput,
  WorkspaceAgentReadStateCommandInput,
  WorkspaceAgentReadStateCommandOutput,
  WorkspaceAgentResetCommandInput,
  WorkspaceAgentResumeInputRequestCommandInput,
  WorkspaceAgentSubmitCommandInput,
} from "@agent-os/core/workspace-agent";
export { WORKSPACE_AGENT_COMMAND } from "@agent-os/core/workspace-agent";

export type WorkspaceAgentCommandMap = {
  readonly [Name in keyof WorkspaceAgentCommandInputByName]: AgentClientCommandSpec<
    WorkspaceAgentCommandInputByName[Name],
    WorkspaceAgentCommandOutputByName[Name]
  >;
};

export type WorkspaceAgentClient = AgentClientController<WorkspaceAgentCommandMap>;

export interface CreateWorkspaceAgentClientOptions {
  readonly streamSource?: AgentClientStreamSource;
  readonly rpcInvoker?: WorkspaceAgentClient["invoke"];
  readonly initialEvents?: ReadonlyArray<RuntimeLedgerEvent>;
}

export const createWorkspaceAgentClient = (
  options: CreateWorkspaceAgentClientOptions = {},
): WorkspaceAgentClient => createAgentClient<WorkspaceAgentCommandMap>(options);

export interface WorkspaceAgentClientBridge {
  readonly client: WorkspaceAgentClient;
  submit(
    input: SubmitRunInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.SUBMIT]>;
  resumeInputRequest(
    input: WorkspaceAgentResumeInputRequestCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<
    WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST]
  >;
  decideInputRequest(
    input: WorkspaceAgentDecideInputRequestCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<
    WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST]
  >;
  readState(
    input?: WorkspaceAgentReadStateCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentReadStateCommandOutput>;
  readFile(
    input: WorkspaceAgentReadFileCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentReadFileCommandOutput>;
  reset(
    input?: WorkspaceAgentResetCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentMutationCommandOutput>;
  destroy(
    input?: WorkspaceAgentDestroyCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentMutationCommandOutput>;
  custom(
    input: WorkspaceAgentCustomCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<unknown>;
}

export const createWorkspaceAgentClientBridge = (
  options: CreateWorkspaceAgentClientOptions = {},
): WorkspaceAgentClientBridge => {
  const client = createWorkspaceAgentClient(options);
  return {
    client,
    submit(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.SUBMIT, { input }, commandOptions);
    },
    resumeInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST, input, commandOptions);
    },
    decideInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST, input, commandOptions);
    },
    readState(input = {}, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.READ_STATE, input, commandOptions);
    },
    readFile(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.READ_FILE, input, commandOptions);
    },
    reset(input = {}, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.RESET, input, commandOptions);
    },
    destroy(input = {}, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.DESTROY, input, commandOptions);
    },
    custom(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.CUSTOM, input, commandOptions);
    },
  };
};
