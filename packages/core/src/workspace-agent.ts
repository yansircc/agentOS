import type { Derived } from "./value-brands";
import type {
  AgentManifestProjection,
  InputRequestAnswer,
  InputRequestRef,
  RecordedInputRequestRef,
  RuntimeLedgerEvent,
  SubmitResult,
  SubmitRunInput,
} from "./runtime-protocol";

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
  DECIDE_INPUT_REQUEST: "decideInputRequest",
  READ_STATE: "readState",
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
  Derived<WorkspaceAgentStateProjectionShape>;

export interface WorkspaceAgentFilesProjectionShape {
  readonly schema: typeof WORKSPACE_AGENT_PROJECTION_SCHEMA.FILES;
  readonly workspaceRef: string;
  readonly files: ReadonlyArray<WorkspaceAgentFileEntry>;
  readonly lastObservedEventId?: number;
}

export type WorkspaceAgentFilesProjection = WorkspaceAgentFilesProjectionShape &
  Derived<WorkspaceAgentFilesProjectionShape>;

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
  readonly ref: InputRequestRef;
  readonly decidedBy: string;
  readonly answer: InputRequestAnswer;
}

export type WorkspaceAgentInputRequestDecision =
  | {
      readonly kind: "approved";
      readonly decidedBy: string;
      readonly answer: InputRequestAnswer;
    }
  | {
      readonly kind: "rejected";
      readonly decisionRef: string;
      readonly decidedBy: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "cancelled";
      readonly closeRef: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "expired";
      readonly closeRef: string;
      readonly reason?: string;
    };

export interface WorkspaceAgentDecideInputRequestCommandInput {
  readonly ref: InputRequestRef;
  readonly decision: WorkspaceAgentInputRequestDecision;
}

export interface WorkspaceAgentReadStateCommandInput {
  readonly includeHidden?: boolean;
}

export interface WorkspaceAgentReadStateCommandOutput {
  readonly workspaceRef: string;
  readonly files: ReadonlyArray<WorkspaceAgentFileEntry>;
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

export type WorkspaceAgentCommandInputByName = {
  readonly [WORKSPACE_AGENT_COMMAND.SUBMIT]: WorkspaceAgentSubmitCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST]: WorkspaceAgentResumeInputRequestCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST]: WorkspaceAgentDecideInputRequestCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.READ_STATE]: WorkspaceAgentReadStateCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.READ_FILE]: WorkspaceAgentReadFileCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.RESET]: WorkspaceAgentResetCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.DESTROY]: WorkspaceAgentDestroyCommandInput;
  readonly [WORKSPACE_AGENT_COMMAND.CUSTOM]: WorkspaceAgentCustomCommandInput;
};

export type WorkspaceAgentCommandOutputByName = {
  readonly [WORKSPACE_AGENT_COMMAND.SUBMIT]: SubmitResult;
  readonly [WORKSPACE_AGENT_COMMAND.RESUME_INPUT_REQUEST]: SubmitResult;
  readonly [WORKSPACE_AGENT_COMMAND.DECIDE_INPUT_REQUEST]: SubmitResult;
  readonly [WORKSPACE_AGENT_COMMAND.READ_STATE]: WorkspaceAgentReadStateCommandOutput;
  readonly [WORKSPACE_AGENT_COMMAND.READ_FILE]: WorkspaceAgentReadFileCommandOutput;
  readonly [WORKSPACE_AGENT_COMMAND.RESET]: WorkspaceAgentMutationCommandOutput;
  readonly [WORKSPACE_AGENT_COMMAND.DESTROY]: WorkspaceAgentMutationCommandOutput;
  readonly [WORKSPACE_AGENT_COMMAND.CUSTOM]: unknown;
};

export interface WorkspaceAgentDriverMount {
  readonly kind: "driver_mount";
  readonly client: unknown;
}

export interface WorkspaceAgentGeneratedMount {
  readonly driver: WorkspaceAgentDriverMount;
  readonly projectionSinks: ReadonlyArray<WorkspaceAgentProjectionSink>;
}

export const defineWorkspaceAgentMount = (
  mount: WorkspaceAgentGeneratedMount,
): WorkspaceAgentGeneratedMount => mount;

export const isWorkspaceAgentProjectionName = (
  value: string,
): value is WorkspaceAgentProjectionName =>
  (Object.values(WORKSPACE_AGENT_PROJECTION) as ReadonlyArray<string>).includes(value);

export const isWorkspaceAgentCommandName = (value: string): value is WorkspaceAgentCommandName =>
  (Object.values(WORKSPACE_AGENT_COMMAND) as ReadonlyArray<string>).includes(value);
