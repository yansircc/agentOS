import type { StaticTargetModuleImport } from "../model";
import { renderNamedImport, renderTypeImport, staticTargetModules } from "../encoding";
import {
  generatedCommandInputTypesForProfile,
  renderGeneratedCommandCases,
  renderGeneratedCommandRpcType,
} from "../../generated-command-projection";

export const generatedWorkspaceClientModuleImports = (
  modules: ReturnType<typeof staticTargetModules>,
): ReadonlyArray<StaticTargetModuleImport> => [
  {
    kind: "workspace-client",
    source: modules.workspaceAgentClient,
    imports: [
      "createWorkspaceAgentClientBridge",
      "CreateWorkspaceAgentClientOptions",
      "WorkspaceAgentClientBridge",
      "WorkspaceAgentProductClient",
      "WorkspaceAgentProductCommandMap",
      "WorkspaceAgentProductProjectionTypes",
      "WorkspaceAgentProductCommandOutputByName",
      "WORKSPACE_AGENT_PRODUCT_COMMAND",
    ],
  },
  {
    kind: "workspace-client",
    source: modules.productShellClient,
    imports: ["AgentSession", "createAgentSession"],
  },
];

export const generatedChatClientModuleImports = (
  modules: ReturnType<typeof staticTargetModules>,
): ReadonlyArray<StaticTargetModuleImport> => [
  {
    kind: "workspace-client",
    source: modules.workspaceAgentClient,
    imports: [
      "WORKSPACE_AGENT_COMMAND",
      "createWorkspaceAgentClient",
      "CreateWorkspaceAgentClientOptions",
      "WorkspaceAgentClient",
      "WorkspaceAgentCommandOutputByName",
    ],
  },
];

export const generatedSvelteKitClientModuleImports = (
  modules: ReturnType<typeof staticTargetModules>,
): ReadonlyArray<StaticTargetModuleImport> => [
  {
    kind: "client-transport",
    source: "./sveltekit.remote",
    imports: ["invokeAgentCommand", "runEventStream"],
  },
  {
    kind: "client-transport",
    source: modules.svelteKitServer,
    imports: ["command", "getRequestEvent", "query"],
  },
  {
    kind: "client-transport",
    source: modules.sseHttp,
    imports: ["decodeSseHttpEvents", "responseToSseHttpChunks"],
  },
  {
    kind: "client-core",
    source: modules.clientCore,
    imports: ["AgentClientSnapshot"],
  },
  {
    kind: "client-framework",
    source: modules.clientSvelte,
    imports: ["clientReadable", "selectClientReadable"],
  },
  {
    kind: "client-framework",
    source: modules.svelteStore,
    imports: ["Readable"],
  },
];

export const renderWorkspaceSvelteKitRemote = (
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)}
${renderNamedImport(["decodeSseHttpEvents", "responseToSseHttpChunks"], modules.sseHttp)}
${renderNamedImport(["Result", "Schema"], modules.effect)}
${renderNamedImport(["WORKSPACE_AGENT_COMMAND"], modules.workspaceAgentHost)}
${renderNamedImport(["WORKSPACE_AGENT_PRODUCT_COMMAND"], modules.workspaceAgentClient)}
${renderNamedImport(
  ["decodeRuntimeLedgerEvent", "isInputRequestRef", "parseInputRequestResumePayload"],
  modules.runtimeProtocol,
)}
${renderNamedImport(["agentOSRpcClient", "agentOSTruthIdentity"], "./cloudflare-scope")}
${renderTypeImport(["AgentRuntimeClient"], modules.cloudflareDoRuntime)}
${renderTypeImport(["SseHttpEvent"], modules.sseHttp)}
${renderTypeImport(
  ["RuntimeLedgerEvent", "SubmitResult", "SubmitRunInput"],
  modules.runtimeProtocol,
)}
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
  ["WorkspaceAgentCommandOutputByName", ...generatedCommandInputTypesForProfile("workspace")],
  modules.workspaceAgentHost,
)}
${renderTypeImport(
  [
    "WorkspaceAgentSessionSubmitTurnInput",
    "WorkspaceAgentWorkflowRunInput",
    "WorkspaceAgentWorkflowRunRef",
    "WorkspaceAgentWorkflowRunsInput",
  ],
  modules.workspaceAgentClient,
)}
${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

type AgentOSRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
  readonly submitSessionTurn: (input: WorkspaceAgentSessionSubmitTurnInput) => Promise<SubmitResult>;
  readonly inspectSession: (
    input: { readonly sessionRef: string },
  ) => Promise<AgentSessionProjection>;
  readonly listSessions: () => Promise<AgentSessionListProjection>;
  readonly runWorkflow: (input: WorkspaceAgentWorkflowRunInput) => Promise<SubmitResult>;
  readonly inspectWorkflowRun: (
    input: WorkspaceAgentWorkflowRunRef,
  ) => Promise<WorkflowRunProjection | null>;
  readonly listWorkflowRuns: (
    input: WorkspaceAgentWorkflowRunsInput,
  ) => Promise<WorkflowRunListProjection>;
${renderGeneratedCommandRpcType("workspace")}
};

const optionalAfterIdInput = Schema.toStandardSchemaV1(
  Schema.Struct({ afterId: Schema.optional(Schema.Number) }),
);
const commandInput = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String,
    input: Schema.Unknown,
  }),
);

type GeneratedFailure = {
  readonly ok: false;
  readonly status: number;
  readonly message: string;
};

type GeneratedResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | GeneratedFailure;

const fail = (status: number, message: string): GeneratedFailure => ({
  ok: false,
  status,
  message,
});

const rejectFailure = (failure: GeneratedFailure): Promise<never> =>
  Promise.reject(
    Object.assign(Error(failure.message), {
      status: failure.status,
      body: { message: failure.message },
    }),
  );

const env = (): GeneratedResult<AgentOSTargetEnv> => {
  const platformEnv = getRequestEvent().platform?.env;
  if (platformEnv === undefined) return fail(500, "Cloudflare platform env missing");
  return { ok: true, value: platformEnv as AgentOSTargetEnv };
};

const agentOS = (platformEnv: AgentOSTargetEnv) =>
  agentOSRpcClient<AgentOSRpc>(platformEnv);

type AgentOSRemote = ReturnType<typeof agentOS>;
type AgentOSSubmitRunInput = Parameters<AgentOSRemote["submitRunInput"]>[0];
type AgentOSSessionSubmitTurnInput = Parameters<AgentOSRemote["submitSessionTurn"]>[0];
type AgentOSWorkflowRunInput = Parameters<AgentOSRemote["runWorkflow"]>[0];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const submitInputFromUnknown = (
  value: unknown,
): GeneratedResult<{ readonly input: AgentOSSubmitRunInput }> => {
  if (!isRecord(value) || !isRecord(value.input)) return fail(400, "invalid submit command input");
  if (typeof value.input.intent !== "string" || !isRecord(value.input.context)) {
    return fail(400, "invalid submit run input");
  }
  return { ok: true, value: { input: value.input as unknown as AgentOSSubmitRunInput } };
};

const productSubmitInputFromUnknown = (
  value: unknown,
  label: string,
): GeneratedResult<AgentOSSubmitRunInput> => {
  if (!isRecord(value)) return fail(400, \`invalid \${label} command input\`);
  if (typeof value.intent !== "string" || !isRecord(value.context)) {
    return fail(400, \`invalid \${label} submit run input\`);
  }
  return { ok: true, value: value as unknown as AgentOSSubmitRunInput };
};

const sessionTurnInputFromUnknown = (
  value: unknown,
): GeneratedResult<AgentOSSessionSubmitTurnInput> => {
  const submitInput = productSubmitInputFromUnknown(value, "submitSessionTurn");
  if (!submitInput.ok) return submitInput;
  if (!isRecord(value)) return fail(400, "invalid submitSessionTurn command input");
  if (typeof value.sessionRef !== "string" || typeof value.turnRef !== "string") {
    return fail(400, "invalid session turn identity");
  }
  return { ok: true, value: value as unknown as AgentOSSessionSubmitTurnInput };
};

const sessionInspectInputFromUnknown = (
  value: unknown,
): GeneratedResult<{ readonly sessionRef: string }> => {
  if (!isRecord(value) || typeof value.sessionRef !== "string") {
    return fail(400, "invalid inspectSession command input");
  }
  return { ok: true, value: { sessionRef: value.sessionRef } };
};

const workflowRunInputFromUnknown = (
  value: unknown,
): GeneratedResult<AgentOSWorkflowRunInput> => {
  const submitInput = productSubmitInputFromUnknown(value, "runWorkflow");
  if (!submitInput.ok) return submitInput;
  if (!isRecord(value)) return fail(400, "invalid runWorkflow command input");
  if (typeof value.workflowId !== "string" || typeof value.workflowRunId !== "string") {
    return fail(400, "invalid workflow run identity");
  }
  if (value.idempotencyKey !== undefined && typeof value.idempotencyKey !== "string") {
    return fail(400, "invalid workflow run idempotencyKey");
  }
  if (value.inputDigest !== undefined && typeof value.inputDigest !== "string") {
    return fail(400, "invalid workflow run inputDigest");
  }
  return { ok: true, value: value as unknown as AgentOSWorkflowRunInput };
};

const workflowRunRefFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentWorkflowRunRef> => {
  if (!isRecord(value)) return fail(400, "invalid inspectWorkflowRun command input");
  if (typeof value.workflowId !== "string" || typeof value.workflowRunId !== "string") {
    return fail(400, "invalid workflow run identity");
  }
  return {
    ok: true,
    value: { workflowId: value.workflowId, workflowRunId: value.workflowRunId },
  };
};

const workflowRunsInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentWorkflowRunsInput> => {
  if (!isRecord(value) || typeof value.workflowId !== "string") {
    return fail(400, "invalid listWorkflowRuns command input");
  }
  return { ok: true, value: { workflowId: value.workflowId } };
};

const resumeInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentResumeInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid resumeInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid resumeInputRequest ref");
  const ref = value.ref;
  if (typeof value.decidedBy !== "string" || value.decidedBy.length === 0) {
    return fail(400, "invalid resumeInputRequest decidedBy");
  }
  if (!isRecord(value.answer) || typeof value.answer.decisionRef !== "string") {
    return fail(400, "invalid resumeInputRequest answer");
  }
  const parsed = parseInputRequestResumePayload(ref.requestKind, value.answer.resume);
  if (!parsed.ok) return fail(400, parsed.reason);
  return {
    ok: true,
    value: {
      ref,
      decidedBy: value.decidedBy,
      answer: {
        decisionRef: value.answer.decisionRef,
        resume: parsed.resume,
      },
    },
  };
};

const decideInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentDecideInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid decideInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid decideInputRequest ref");
  if (!isRecord(value.decision) || typeof value.decision.kind !== "string") {
    return fail(400, "invalid decideInputRequest decision");
  }
  const ref = value.ref;
  const decision = value.decision;
  if (decision.kind === "approved") {
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) {
      return fail(400, "invalid decideInputRequest decidedBy");
    }
    if (!isRecord(decision.answer) || typeof decision.answer.decisionRef !== "string") {
      return fail(400, "invalid decideInputRequest answer");
    }
    const parsed = parseInputRequestResumePayload(ref.requestKind, decision.answer.resume);
    if (!parsed.ok) return fail(400, parsed.reason);
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: "approved",
          decidedBy: decision.decidedBy,
          answer: {
            decisionRef: decision.answer.decisionRef,
            resume: parsed.resume,
          },
        },
      },
    };
  }
  if (decision.kind === "rejected") {
    if (typeof decision.decisionRef !== "string" || decision.decisionRef.length === 0) {
      return fail(400, "invalid decideInputRequest decisionRef");
    }
    if (typeof decision.decidedBy !== "string" || decision.decidedBy.length === 0) {
      return fail(400, "invalid decideInputRequest decidedBy");
    }
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: "rejected",
          decisionRef: decision.decisionRef,
          decidedBy: decision.decidedBy,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        },
      },
    };
  }
  if (decision.kind === "cancelled" || decision.kind === "expired") {
    if (typeof decision.closeRef !== "string" || decision.closeRef.length === 0) {
      return fail(400, "invalid decideInputRequest closeRef");
    }
    return {
      ok: true,
      value: {
        ref,
        decision: {
          kind: decision.kind,
          closeRef: decision.closeRef,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        },
      },
    };
  }
  return fail(400, "unsupported decideInputRequest decision");
};

const inspectInputRequestFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentInspectInputRequestCommandInput> => {
  if (!isRecord(value)) return fail(400, "invalid inspectInputRequest command input");
  if (!isInputRequestRef(value.ref)) return fail(400, "invalid inspectInputRequest ref");
  return { ok: true, value: { ref: value.ref } };
};

const customInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentCustomCommandInput> => {
  if (!isRecord(value) || typeof value.method !== "string" || value.method.length === 0) {
    return fail(400, "invalid custom command input");
  }
  return { ok: true, value: { method: value.method, input: value.input } };
};

const readStateInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentReadStateCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid readState command input");
  if (value.includeHidden !== undefined && typeof value.includeHidden !== "boolean") {
    return fail(400, "invalid readState includeHidden");
  }
  return {
    ok: true,
    value:
      value.includeHidden === undefined
        ? {}
        : { includeHidden: value.includeHidden },
  };
};

const readFileInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentReadFileCommandInput> => {
  if (!isRecord(value) || typeof value.path !== "string") {
    return fail(400, "invalid readFile command input");
  }
  if (value.encoding !== undefined && value.encoding !== "utf-8") {
    return fail(400, "unsupported readFile encoding");
  }
  return {
    ok: true,
    value: {
      path: value.path,
      ...(value.encoding === undefined ? {} : { encoding: value.encoding }),
    },
  };
};

const resetInputFromUnknown = (value: unknown): GeneratedResult<WorkspaceAgentResetCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid reset command input");
  return { ok: true, value: typeof value.reason === "string" ? { reason: value.reason } : {} };
};

const destroyInputFromUnknown = (
  value: unknown,
): GeneratedResult<WorkspaceAgentDestroyCommandInput> => {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) return fail(400, "invalid destroy command input");
  return { ok: true, value: typeof value.reason === "string" ? { reason: value.reason } : {} };
};

const runtimeEventFromLedger = (
  event: Parameters<typeof decodeRuntimeLedgerEvent>[0],
): RuntimeLedgerEvent | null => {
  const decoded = decodeRuntimeLedgerEvent(event);
  return decoded._tag === "runtime" ? decoded.event : null;
};

const jsonValueFromString = (data: string): GeneratedResult<unknown> =>
  Result.match(
    Result.try({
      try: () => JSON.parse(data) as unknown,
      catch: () => "invalid ledger stream event: malformed JSON",
    }),
    {
      onFailure: (message) => fail(502, message),
      onSuccess: (value) => ({ ok: true, value }),
    },
  );

const ledgerEventFromSse = (
  event: SseHttpEvent,
): GeneratedResult<Parameters<typeof decodeRuntimeLedgerEvent>[0] | null> => {
  if (event.event !== "ledger") return { ok: true, value: null };
  if (event.data.trim().length === 0) {
    return fail(502, "invalid ledger stream event: empty data");
  }
  const parsed = jsonValueFromString(event.data);
  return parsed.ok
    ? { ok: true, value: parsed.value as Parameters<typeof decodeRuntimeLedgerEvent>[0] }
    : parsed;
};

const emptyRuntimeEvents = (): AsyncIterable<RuntimeLedgerEvent> => ({
  [Symbol.asyncIterator]() {
    return {
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    };
  },
});

const runtimeEventsFromSse = (response: Response): AsyncIterable<RuntimeLedgerEvent> => {
  if (response.body === null) return emptyRuntimeEvents();
  const source = decodeSseHttpEvents(responseToSseHttpChunks(response));
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      const next = (): Promise<IteratorResult<RuntimeLedgerEvent>> =>
        iterator.next().then((result) => {
          if (result.done === true) return { done: true, value: undefined };
          const ledgerEvent = ledgerEventFromSse(result.value);
          if (!ledgerEvent.ok) return rejectFailure(ledgerEvent);
          if (ledgerEvent.value === null) return next();
          const runtimeEvent = runtimeEventFromLedger(ledgerEvent.value);
          return runtimeEvent === null ? next() : { done: false, value: runtimeEvent };
        });
      return {
        next,
        return: () =>
          iterator.return === undefined
            ? Promise.resolve({ done: true, value: undefined })
            : iterator.return(undefined).then(() => ({ done: true, value: undefined })),
      };
    },
  };
};

export const invokeAgentCommand = command(commandInput, ({ name, input }): Promise<unknown> => {
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  const runtime = agentOS(platformEnv.value);
${renderGeneratedCommandCases("workspace")}
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.SUBMIT_SESSION_TURN) {
    const sessionInput = sessionTurnInputFromUnknown(input);
    return sessionInput.ok ? runtime.submitSessionTurn(sessionInput.value) : rejectFailure(sessionInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION) {
    const sessionInput = sessionInspectInputFromUnknown(input);
    return sessionInput.ok ? runtime.inspectSession(sessionInput.value) : rejectFailure(sessionInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS) {
    return runtime.listSessions();
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.RUN_WORKFLOW) {
    const workflowInput = workflowRunInputFromUnknown(input);
    return workflowInput.ok ? runtime.runWorkflow(workflowInput.value) : rejectFailure(workflowInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN) {
    const workflowInput = workflowRunRefFromUnknown(input);
    return workflowInput.ok
      ? runtime.inspectWorkflowRun(workflowInput.value)
      : rejectFailure(workflowInput);
  }
  if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS) {
    const workflowInput = workflowRunsInputFromUnknown(input);
    return workflowInput.ok
      ? runtime.listWorkflowRuns(workflowInput.value)
      : rejectFailure(workflowInput);
  }
  return rejectFailure(fail(501, \`unsupported generated workspace command \${name}\`));
});

export const runEventStream = query.live(optionalAfterIdInput, (input) => {
  const afterId = input.afterId ?? 0;
  const platformEnv = env();
  if (!platformEnv.ok) return rejectFailure(platformEnv);
  return agentOS(platformEnv.value)
    .streamEvents(agentOSTruthIdentity, afterId > 0 ? { afterId } : {})
    .then(runtimeEventsFromSse);
});
`;
