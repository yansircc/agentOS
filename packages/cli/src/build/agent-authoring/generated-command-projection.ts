import {
  WORKSPACE_AGENT_COMMAND_DESCRIPTOR,
  type WorkspaceAgentCommandKey,
} from "@agent-os/core/workspace-agent";

export type GeneratedCommandProfile = "chat" | "workspace";

interface GeneratedCommandProjection {
  readonly key: WorkspaceAgentCommandKey;
  readonly parser: string;
  readonly rpcMethod: string;
  readonly inputType: string;
  readonly parserValueSuffix: "" | ".input";
  readonly clientMethod: string;
  readonly clientArgument: "input" | "{ input }";
  readonly rpcInputOptional?: true;
}

type GeneratedCommandProjectionByKey = {
  readonly [Key in WorkspaceAgentCommandKey]: Omit<GeneratedCommandProjection, "key">;
};

const generatedCommandProjectionByKey = {
  SUBMIT: {
    parser: "submitInputFromUnknown",
    rpcMethod: "submitRunInput",
    inputType: "SubmitRunInput",
    parserValueSuffix: ".input",
    clientMethod: "submit",
    clientArgument: "{ input }",
  },
  RESUME_INPUT_REQUEST: {
    parser: "resumeInputRequestFromUnknown",
    rpcMethod: "resumeInputRequest",
    inputType: "WorkspaceAgentResumeInputRequestCommandInput",
    parserValueSuffix: "",
    clientMethod: "resumeInputRequest",
    clientArgument: "input",
  },
  DECIDE_INPUT_REQUEST: {
    parser: "decideInputRequestFromUnknown",
    rpcMethod: "decideInputRequest",
    inputType: "WorkspaceAgentDecideInputRequestCommandInput",
    parserValueSuffix: "",
    clientMethod: "decideInputRequest",
    clientArgument: "input",
  },
  INSPECT_INPUT_REQUEST: {
    parser: "inspectInputRequestFromUnknown",
    rpcMethod: "inspectInputRequest",
    inputType: "WorkspaceAgentInspectInputRequestCommandInput",
    parserValueSuffix: "",
    clientMethod: "inspectInputRequest",
    clientArgument: "input",
  },
  READ_STATE: {
    parser: "readStateInputFromUnknown",
    rpcMethod: "readWorkspaceState",
    inputType: "WorkspaceAgentReadStateCommandInput",
    parserValueSuffix: "",
    clientMethod: "readState",
    clientArgument: "input",
    rpcInputOptional: true,
  },
  READ_FILE: {
    parser: "readFileInputFromUnknown",
    rpcMethod: "readWorkspaceFile",
    inputType: "WorkspaceAgentReadFileCommandInput",
    parserValueSuffix: "",
    clientMethod: "readFile",
    clientArgument: "input",
  },
  RESET: {
    parser: "resetInputFromUnknown",
    rpcMethod: "resetWorkspace",
    inputType: "WorkspaceAgentResetCommandInput",
    parserValueSuffix: "",
    clientMethod: "reset",
    clientArgument: "input",
    rpcInputOptional: true,
  },
  DESTROY: {
    parser: "destroyInputFromUnknown",
    rpcMethod: "destroyWorkspace",
    inputType: "WorkspaceAgentDestroyCommandInput",
    parserValueSuffix: "",
    clientMethod: "destroy",
    clientArgument: "input",
    rpcInputOptional: true,
  },
  CUSTOM: {
    parser: "customInputFromUnknown",
    rpcMethod: "customCommand",
    inputType: "WorkspaceAgentCustomCommandInput",
    parserValueSuffix: "",
    clientMethod: "custom",
    clientArgument: "input",
  },
} as const satisfies GeneratedCommandProjectionByKey;

const commandKeys = Object.keys(
  WORKSPACE_AGENT_COMMAND_DESCRIPTOR,
) as ReadonlyArray<WorkspaceAgentCommandKey>;

export const generatedCommandProjectionForProfile = (
  profile: GeneratedCommandProfile,
): ReadonlyArray<GeneratedCommandProjection> =>
  commandKeys
    .filter(
      (key) =>
        profile === "workspace" || WORKSPACE_AGENT_COMMAND_DESCRIPTOR[key].surface === "common",
    )
    .map((key) => ({ key, ...generatedCommandProjectionByKey[key] }));

export const generatedCommandInputTypesForProfile = (
  profile: GeneratedCommandProfile,
): ReadonlyArray<string> =>
  Array.from(
    new Set(
      generatedCommandProjectionForProfile(profile)
        .map((projection) => projection.inputType)
        .filter((inputType) => inputType !== "SubmitRunInput"),
    ),
  );

export const renderGeneratedCommandRpcType = (profile: GeneratedCommandProfile): string =>
  generatedCommandProjectionForProfile(profile)
    .map(
      ({ key, rpcMethod, inputType, rpcInputOptional }) =>
        `  readonly ${rpcMethod}: (\n    input${rpcInputOptional === true ? "?" : ""}: ${inputType},\n  ) => Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.${key}]>;`,
    )
    .join("\n");

export const renderGeneratedCommandCases = (profile: GeneratedCommandProfile): string =>
  generatedCommandProjectionForProfile(profile)
    .map(
      ({
        key,
        parser,
        rpcMethod,
        parserValueSuffix,
      }) => `  if (name === WORKSPACE_AGENT_COMMAND.${key}) {
    const parsed = ${parser}(input);
    return parsed.ok
      ? runtime.${rpcMethod}(parsed.value${parserValueSuffix})
      : rejectFailure(parsed);
  }`,
    )
    .join("\n");

export const renderGeneratedCommandDispatch = (
  profile: GeneratedCommandProfile,
  unsupportedLabel: string,
): string => `${renderGeneratedCommandCases(profile)}
  return rejectFailure(fail(501, \`unsupported generated ${unsupportedLabel} command \${name}\`));`;

export const renderGeneratedClientTypeMethods = (profile: GeneratedCommandProfile): string =>
  generatedCommandProjectionForProfile(profile)
    .map(
      ({ key, clientMethod, inputType }) => `  ${clientMethod}(
    input: ${inputType},
    options?: AgentClientCommandOptions,
  ): Promise<WorkspaceAgentCommandOutputByName[typeof WORKSPACE_AGENT_COMMAND.${key}]>;`,
    )
    .join("\n");

export const renderGeneratedClientMethods = (profile: GeneratedCommandProfile): string =>
  generatedCommandProjectionForProfile(profile)
    .map(
      ({ key, clientMethod, clientArgument }) => `    ${clientMethod}(input, commandOptions) {
      return client.invoke(WORKSPACE_AGENT_COMMAND.${key}, ${clientArgument}, commandOptions);
    },`,
    )
    .join("\n");
