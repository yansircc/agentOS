import type { Recorded } from "@agent-os/kernel";
import type { AgentClientStreamSource, AgentClientCommandSpec } from "@agent-os/client";
import { createAgentClient, type AgentClientController } from "@agent-os/client";
import type {
  AgentManifestProjection,
  InputRequestAnswer,
  RecordedInputRequestRef,
  RuntimeLedgerEvent,
  SubmitResult,
  SubmitRunInput,
} from "@agent-os/runtime-protocol";
import type { WorkspaceEnv } from "@agent-os/workspace-env";

export const WORKSPACE_AGENT_PROJECTION_SCHEMA = {
  STATE: "agentos.workspace_agent.state.v1",
  FILES: "agentos.workspace_agent.files.v1",
} as const;

export type WorkspaceAgentProjectionSchema =
  (typeof WORKSPACE_AGENT_PROJECTION_SCHEMA)[keyof typeof WORKSPACE_AGENT_PROJECTION_SCHEMA];

export const WORKSPACE_AGENT_PROJECTION = {
  STATE: "workspace.state",
  FILES: "workspace.files",
  RUN_EVENTS: "runtime.events",
  INPUT_REQUESTS: "runtime.input_requests",
  AGENT_INFO: "agent.info",
} as const;

export type WorkspaceAgentProjectionName =
  (typeof WORKSPACE_AGENT_PROJECTION)[keyof typeof WORKSPACE_AGENT_PROJECTION];

export const WORKSPACE_AGENT_COMMAND = {
  SUBMIT: "submit",
  RESUME_INPUT_REQUEST: "resumeInputRequest",
  READ_FILE: "readFile",
  RESET: "reset",
  DESTROY: "destroy",
  CUSTOM: "custom",
} as const;

export type WorkspaceAgentCommandName =
  (typeof WORKSPACE_AGENT_COMMAND)[keyof typeof WORKSPACE_AGENT_COMMAND];

export interface WorkspaceAgentFileEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "other";
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly sha256?: string;
}

export interface WorkspaceAgentStateProjectionShape {
  readonly schema: typeof WORKSPACE_AGENT_PROJECTION_SCHEMA.STATE;
  readonly workspaceRef: string;
  readonly files: ReadonlyArray<WorkspaceAgentFileEntry>;
  readonly lastObservedEventId?: number;
}

export type WorkspaceAgentStateProjection = WorkspaceAgentStateProjectionShape &
  Recorded<WorkspaceAgentStateProjectionShape>;

export interface WorkspaceAgentFilesProjectionShape {
  readonly schema: typeof WORKSPACE_AGENT_PROJECTION_SCHEMA.FILES;
  readonly workspaceRef: string;
  readonly files: ReadonlyArray<WorkspaceAgentFileEntry>;
  readonly lastObservedEventId?: number;
}

export type WorkspaceAgentFilesProjection = WorkspaceAgentFilesProjectionShape &
  Recorded<WorkspaceAgentFilesProjectionShape>;

export type WorkspaceAgentProjectionValueByName = {
  readonly [WORKSPACE_AGENT_PROJECTION.STATE]: WorkspaceAgentStateProjection;
  readonly [WORKSPACE_AGENT_PROJECTION.FILES]: WorkspaceAgentFilesProjection;
  readonly [WORKSPACE_AGENT_PROJECTION.RUN_EVENTS]: ReadonlyArray<RuntimeLedgerEvent>;
  readonly [WORKSPACE_AGENT_PROJECTION.INPUT_REQUESTS]: ReadonlyArray<RecordedInputRequestRef>;
  readonly [WORKSPACE_AGENT_PROJECTION.AGENT_INFO]: AgentManifestProjection;
};

export interface WorkspaceAgentProjectionRead<
  Name extends WorkspaceAgentProjectionName = WorkspaceAgentProjectionName,
> {
  readonly name: Name;
  readonly value: WorkspaceAgentProjectionValueByName[Name];
}

export type WorkspaceAgentProjectionSink<
  Name extends WorkspaceAgentProjectionName = WorkspaceAgentProjectionName,
> = {
  readonly kind: "projection_sink";
  readonly name: Name;
};

export interface WorkspaceAgentSubmitCommandInput {
  readonly input: SubmitRunInput;
}

export interface WorkspaceAgentResumeInputRequestCommandInput {
  readonly ref: RecordedInputRequestRef;
  readonly answer: InputRequestAnswer;
}

export interface WorkspaceAgentReadFileCommandInput {
  readonly path: string;
  readonly encoding?: "utf-8";
}

export interface WorkspaceAgentReadFileCommandOutput {
  readonly path: string;
  readonly content: string;
}

export interface WorkspaceAgentResetCommandInput {
  readonly reason?: string;
}

export interface WorkspaceAgentDestroyCommandInput {
  readonly reason?: string;
}

export interface WorkspaceAgentMutationCommandOutput {
  readonly ok: true;
}

export interface WorkspaceAgentCustomCommandInput {
  readonly method: string;
  readonly input: unknown;
}

export type WorkspaceAgentCommandMap = {
  readonly [WORKSPACE_AGENT_COMMAND.SUBMIT]: AgentClientCommandSpec<
    WorkspaceAgentSubmitCommandInput,
    SubmitResult
  >;
  readonly [WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST]: AgentClientCommandSpec<
    WorkspaceAgentResumeInputRequestCommandInput,
    SubmitResult
  >;
  readonly [WORKSPACE_AGENT_COMMAND.READ_FILE]: AgentClientCommandSpec<
    WorkspaceAgentReadFileCommandInput,
    WorkspaceAgentReadFileCommandOutput
  >;
  readonly [WORKSPACE_AGENT_COMMAND.RESET]: AgentClientCommandSpec<
    WorkspaceAgentResetCommandInput,
    WorkspaceAgentMutationCommandOutput
  >;
  readonly [WORKSPACE_AGENT_COMMAND.DESTROY]: AgentClientCommandSpec<
    WorkspaceAgentDestroyCommandInput,
    WorkspaceAgentMutationCommandOutput
  >;
  readonly [WORKSPACE_AGENT_COMMAND.CUSTOM]: AgentClientCommandSpec<
    WorkspaceAgentCustomCommandInput,
    unknown
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

export interface WorkspaceAgentDriverMount {
  readonly kind: "driver_mount";
  readonly client: WorkspaceAgentClient;
}

export interface WorkspaceAgentGeneratedMount {
  readonly driver: WorkspaceAgentDriverMount;
  readonly projectionSinks: ReadonlyArray<WorkspaceAgentProjectionSink>;
}

export const defineWorkspaceAgentMount = (
  mount: WorkspaceAgentGeneratedMount,
): WorkspaceAgentGeneratedMount => mount;

export interface WorkspaceAgentReconcileContext<Projection, Fact extends object> {
  readonly sandbox: WorkspaceEnv;
  readonly projection: Projection;
  readonly append: (fact: Fact & Recorded<Fact>) => Promise<void>;
  readonly signal?: AbortSignal;
}

export type WorkspaceAgentReconcile<Projection, Fact extends object> = (
  context: WorkspaceAgentReconcileContext<Projection, Fact>,
) => Promise<void>;

export const defineReconcile = <Projection, Fact extends object>(
  reconcile: WorkspaceAgentReconcile<Projection, Fact>,
): WorkspaceAgentReconcile<Projection, Fact> => reconcile;

export const isWorkspaceAgentProjectionName = (
  value: string,
): value is WorkspaceAgentProjectionName =>
  (Object.values(WORKSPACE_AGENT_PROJECTION) as ReadonlyArray<string>).includes(value);

export const isWorkspaceAgentCommandName = (value: string): value is WorkspaceAgentCommandName =>
  (Object.values(WORKSPACE_AGENT_COMMAND) as ReadonlyArray<string>).includes(value);
