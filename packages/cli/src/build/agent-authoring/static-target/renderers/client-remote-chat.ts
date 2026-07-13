import { renderNamedImport, renderTypeImport, staticTargetModules } from "../encoding";
import {
  generatedCommandInputTypesForProfile,
  renderGeneratedCommandDispatch,
  renderGeneratedCommandRpcType,
} from "../../generated-command-projection";

export const renderChatSvelteKitRemote = (
  modules: ReturnType<typeof staticTargetModules>,
): string => `${renderNamedImport(["command", "getRequestEvent", "query"], modules.svelteKitServer)}
${renderNamedImport(["decodeSseHttpEvents", "responseToSseHttpChunks"], modules.sseHttp)}
${renderNamedImport(["Result", "Schema"], modules.effect)}
${renderNamedImport(["WORKSPACE_AGENT_COMMAND"], modules.workspaceAgentHost)}
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
  ["WorkspaceAgentCommandOutputByName", ...generatedCommandInputTypesForProfile("chat")],
  modules.workspaceAgentHost,
)}
${renderTypeImport(["AgentOSTargetEnv"], "./cloudflare-scope")}

type AgentOSRpc = Pick<AgentRuntimeClient, "events" | "streamEvents"> & {
${renderGeneratedCommandRpcType("chat")}
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
${renderGeneratedCommandDispatch("chat", "chat")}
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
