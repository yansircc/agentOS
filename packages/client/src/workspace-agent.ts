import type {
  RuntimeLedgerEvent,
  SubmitResult,
  SubmitRunInput,
} from "@agent-os/core/runtime-protocol";
import {
  WORKSPACE_AGENT_COMMAND,
  type WorkspaceAgentCommandInputByName,
  type WorkspaceAgentCommandOutputByName,
  type WorkspaceAgentCustomCommandInput,
  type WorkspaceAgentDecideInputRequestCommandInput,
  type WorkspaceAgentDestroyCommandInput,
  type WorkspaceAgentInspectInputRequestCommandInput,
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
  type AgentClientCommandMap,
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
  WorkspaceAgentInspectInputRequestCommandInput,
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

export const WORKSPACE_AGENT_PRODUCT_COMMAND = {
  SUBMIT_SESSION_TURN: "submitSessionTurn",
  INSPECT_SESSION: "inspectSession",
  LIST_SESSIONS: "listSessions",
  RUN_WORKFLOW: "runWorkflow",
  INSPECT_WORKFLOW_RUN: "inspectWorkflowRun",
  LIST_WORKFLOW_RUNS: "listWorkflowRuns",
} as const;

export type WorkspaceAgentProductCommandName =
  (typeof WORKSPACE_AGENT_PRODUCT_COMMAND)[keyof typeof WORKSPACE_AGENT_PRODUCT_COMMAND];

export interface WorkspaceAgentSessionSubmitTurnInput extends SubmitRunInput {
  readonly sessionRef: string;
  readonly turnRef: string;
}

export interface WorkspaceAgentSessionInspectInput {
  readonly sessionRef: string;
}

export interface WorkspaceAgentWorkflowRunInput extends SubmitRunInput {
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly idempotencyKey?: string;
  readonly inputDigest?: string;
}

export interface WorkspaceAgentWorkflowRunRef {
  readonly workflowId: string;
  readonly workflowRunId: string;
}

export interface WorkspaceAgentWorkflowRunsInput {
  readonly workflowId: string;
}

export interface WorkspaceAgentProductProjectionTypes {
  readonly session: unknown;
  readonly sessionList: unknown;
  readonly workflowRun: unknown;
  readonly workflowRunList: unknown;
}

export type WorkspaceAgentProductCommandInputByName = {
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.SUBMIT_SESSION_TURN]: WorkspaceAgentSessionSubmitTurnInput;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION]: WorkspaceAgentSessionInspectInput;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS]: Record<string, never>;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.RUN_WORKFLOW]: WorkspaceAgentWorkflowRunInput;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN]: WorkspaceAgentWorkflowRunRef;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS]: WorkspaceAgentWorkflowRunsInput;
};

export type WorkspaceAgentProductCommandOutputByName<
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
> = {
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.SUBMIT_SESSION_TURN]: SubmitResult;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION]: Projections["session"];
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS]: Projections["sessionList"];
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.RUN_WORKFLOW]: SubmitResult;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN]:
    | Projections["workflowRun"]
    | null;
  readonly [WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS]: Projections["workflowRunList"];
};

export type WorkspaceAgentProductCommandMap<
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
> = WorkspaceAgentCommandMap & {
  readonly [Name in keyof WorkspaceAgentProductCommandInputByName]: AgentClientCommandSpec<
    WorkspaceAgentProductCommandInputByName[Name],
    WorkspaceAgentProductCommandOutputByName<Projections>[Name]
  >;
};

export type WorkspaceAgentClient = AgentClientController<WorkspaceAgentCommandMap>;
export type WorkspaceAgentProductClient<
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
> = AgentClientController<WorkspaceAgentProductCommandMap<Projections>>;

export interface CreateWorkspaceAgentClientOptions<
  Commands extends AgentClientCommandMap = WorkspaceAgentCommandMap,
> {
  readonly streamSource?: AgentClientStreamSource;
  readonly rpcInvoker?: AgentClientController<Commands>["invoke"];
  readonly initialEvents?: ReadonlyArray<RuntimeLedgerEvent>;
}

export const createWorkspaceAgentClient = <
  Commands extends AgentClientCommandMap = WorkspaceAgentCommandMap,
>(
  options: CreateWorkspaceAgentClientOptions<Commands> = {},
): AgentClientController<Commands> => createAgentClient<Commands>(options);

export interface WorkspaceAgentSessionsClient<
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
> {
  submitTurn(
    input: WorkspaceAgentSessionSubmitTurnInput,
    options?: AgentClientCommandOptions,
  ): Promise<SubmitResult>;
  inspect(sessionRef: string, options?: AgentClientCommandOptions): Promise<Projections["session"]>;
  list(options?: AgentClientCommandOptions): Promise<Projections["sessionList"]>;
}

export interface WorkspaceAgentWorkflowsClient<
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
> {
  run(
    input: WorkspaceAgentWorkflowRunInput,
    options?: AgentClientCommandOptions,
  ): Promise<SubmitResult>;
  inspectRun(
    workflowId: string,
    workflowRunId: string,
    options?: AgentClientCommandOptions,
  ): Promise<Projections["workflowRun"] | null>;
  listRuns(
    workflowId: string,
    options?: AgentClientCommandOptions,
  ): Promise<Projections["workflowRunList"]>;
}

export interface WorkspaceAgentClientBridge<
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
> {
  readonly client: WorkspaceAgentProductClient<Projections>;
  readonly sessions: WorkspaceAgentSessionsClient<Projections>;
  readonly workflows: WorkspaceAgentWorkflowsClient<Projections>;
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
  inspectInputRequest(
    input: WorkspaceAgentInspectInputRequestCommandInput,
    options?: AgentClientCommandOptions,
  ): Promise<
    WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.INSPECT_INPUT_REQUEST]
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

export const createWorkspaceAgentClientBridge = <
  Projections extends WorkspaceAgentProductProjectionTypes = WorkspaceAgentProductProjectionTypes,
>(
  options: CreateWorkspaceAgentClientOptions<WorkspaceAgentProductCommandMap<Projections>> = {},
): WorkspaceAgentClientBridge<Projections> => {
  const client = createWorkspaceAgentClient<WorkspaceAgentProductCommandMap<Projections>>(options);
  return {
    client,
    sessions: {
      submitTurn(input, commandOptions) {
        return client.invoke(
          WORKSPACE_AGENT_PRODUCT_COMMAND.SUBMIT_SESSION_TURN,
          input,
          commandOptions,
        );
      },
      inspect(sessionRef, commandOptions) {
        return client.invoke(
          WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION,
          { sessionRef },
          commandOptions,
        );
      },
      list(commandOptions) {
        return client.invoke(WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS, {}, commandOptions);
      },
    },
    workflows: {
      run(input, commandOptions) {
        return client.invoke(WORKSPACE_AGENT_PRODUCT_COMMAND.RUN_WORKFLOW, input, commandOptions);
      },
      inspectRun(workflowId, workflowRunId, commandOptions) {
        return client.invoke(
          WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN,
          { workflowId, workflowRunId },
          commandOptions,
        );
      },
      listRuns(workflowId, commandOptions) {
        return client.invoke(
          WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS,
          { workflowId },
          commandOptions,
        );
      },
    },
    submit(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.SUBMIT, { input }, commandOptions);
    },
    resumeInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST, input, commandOptions);
    },
    decideInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST, input, commandOptions);
    },
    inspectInputRequest(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.INSPECT_INPUT_REQUEST, input, commandOptions);
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
