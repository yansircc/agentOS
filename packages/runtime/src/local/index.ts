import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { constants as fsConstants } from "node:fs";
import process from "node:process";
import { Effect } from "effect";
import type { Layer } from "effect";
import { scopeRefKey, type AuthorityRef } from "@agent-os/core/effect-claim";
import type { LlmResponse, LlmRoute, LlmTransport } from "@agent-os/core/llm-protocol";
import type { RefResolver, RefResolverService } from "@agent-os/core/ref-resolver";
import type {
  AgentSubmitBindings,
  InputRequestSettlement,
  LedgerTruthIdentity,
  SubmitSpec,
  SubmitResult,
  SubmitToolContext,
} from "@agent-os/core/runtime-protocol";
import {
  agentRunAbortedEvent,
  submitResumeDecisionFromInputRequestRef,
} from "@agent-os/core/runtime-protocol";
import { ABORT, type AbortKind } from "@agent-os/core/abort";
import type {
  WorkspaceAgentDecideInputRequestCommandInput,
  WorkspaceAgentInspectInputRequestCommandInput,
  WorkspaceAgentResumeInputRequestCommandInput,
} from "@agent-os/core/workspace-agent";
import type { EventQueryOptions, LedgerEvent } from "@agent-os/core/types";
import type { TelemetryFanoutDiagnostic } from "@agent-os/core/telemetry-protocol";
import {
  WORKSPACE_OPERATION_HOST_FACT,
  defineHost,
  resolveRuntime,
  workspaceOperations,
  type CapabilityContract,
  type HostProfile,
  type PreflightDiagnostic,
  type ResolvedRuntime,
  type WorkspaceOperationsOptions,
} from "../capability";
import { projectInspectionSnapshot, type InspectionSnapshot } from "../inspection";
import { inMemoryConversationTruthIdentity } from "../in-memory/state-helpers";
import { InMemoryLlmTransportLive, type InMemoryLlmTransportOptions } from "../in-memory/llm";
import { internalSubmitSpec } from "../internal-submit";
import type { ScheduleFireDeliveryDispatchResult, ScheduleFireDispatchResult } from "../schedule";
import { submitAgentEffect } from "../submit-agent";
import type { SubmitAgentProductLink } from "../submit-agent";
import { BoundaryEvents } from "../boundary-events";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  decisionGateSettlementRef,
  projectDecisionGate,
} from "../decision-gate";
import {
  chatInputForInputRequestResume,
  projectInputRequest,
  projectInputRequestSettlement,
} from "../input-request";
import { projectSubmitResult } from "../run-projector";
import {
  createWorkspaceEnv,
  WORKSPACE_TOOL_NAMES,
  type WorkspaceEnv,
  type WorkspaceEnvBackend,
  type WorkspaceExecOptions,
  type WorkspaceExecResult,
  type WorkspaceFileStat,
} from "../workspace-env-core";
import { defineWorkspaceSessionLease, type WorkspaceSessionLease } from "../workspace-session";
import { Ledger } from "../ledger";
import {
  abortErrorFor,
  checkSignal,
  normalizeAbsolutePath,
  truncateUtf8,
} from "../workspace-env-core/path-policy";
import {
  createLocalRuntimeLedgerSource,
  type LocalRuntimeLedgerSource,
  validateLocalRuntimeLedgerHydrationEvents,
} from "./runtime-ledger-source";

export {
  createLocalRuntimeLedgerSource,
  LocalRuntimeLedgerHydrationError,
  validateLocalRuntimeLedgerHydrationEvents,
} from "./runtime-ledger-source";
export type {
  LocalRuntimeLedgerSource,
  LocalRuntimeLedgerSourceOptions,
} from "./runtime-ledger-source";

export interface CreateLocalWorkspaceEnvOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inheritEnv?: boolean;
}

export interface LocalAgentRuntimeTestLlm extends InMemoryLlmTransportOptions {
  readonly kind?: "test";
  readonly route?: LlmRoute;
}

export interface LocalAgentRuntimeTransportLlm {
  readonly kind: "transport";
  readonly transport: Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly refResolver?: RefResolver;
  readonly route: LlmRoute;
  readonly preflight?: LocalAgentRuntimeLlmPreflight;
}

export type LocalAgentRuntimeLlm = LocalAgentRuntimeTestLlm | LocalAgentRuntimeTransportLlm;

export interface LocalAgentRuntimeLlmPreflightInput {
  readonly route: LlmRoute;
  readonly refResolver?: RefResolver;
  readonly routeBindingRef?: string;
}

export type LocalAgentRuntimeLlmPreflight = (
  input: LocalAgentRuntimeLlmPreflightInput,
) => ReadonlyArray<PreflightDiagnostic>;

export interface CreateLocalAgentRuntimeOptions {
  readonly identity: string;
  readonly truthIdentity?: LedgerTruthIdentity;
  readonly initialEvents?: ReadonlyArray<LedgerEvent>;
  readonly cwd: string;
  readonly env?: CreateLocalWorkspaceEnvOptions["env"];
  readonly inheritEnv?: CreateLocalWorkspaceEnvOptions["inheritEnv"];
  readonly llm?: LocalAgentRuntimeLlm;
  readonly workspaceOperations?: WorkspaceOperationsOptions;
  readonly capabilities?: ReadonlyArray<CapabilityContract>;
}

export type LocalAgentRuntimeTarget = "local@1" | "node@1";

export interface LowerLocalAgentRuntimeOptions extends CreateLocalAgentRuntimeOptions {
  readonly target: LocalAgentRuntimeTarget;
}

export type LocalAgentSubmitInput = Omit<
  SubmitSpec,
  "context" | "effectAuthorityRef" | "route" | "tools"
> & {
  readonly context?: SubmitSpec["context"];
  readonly route?: LlmRoute;
  readonly tools?: SubmitSpec["tools"];
};

export interface LocalAgentRuntime {
  readonly submit: (input: LocalAgentSubmitInput) => Promise<SubmitResult>;
  readonly resumeInputRequest: (
    input: WorkspaceAgentResumeInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly decideInputRequest: (
    input: WorkspaceAgentDecideInputRequestCommandInput,
  ) => Promise<SubmitResult>;
  readonly inspectInputRequest: (
    input: WorkspaceAgentInspectInputRequestCommandInput,
  ) => Promise<InputRequestSettlement>;
  readonly events: (opts?: EventQueryOptions) => ReadonlyArray<LedgerEvent>;
  readonly diagnostics: () => ReadonlyArray<TelemetryFanoutDiagnostic>;
  readonly inspect: () => InspectionSnapshot;
}

export interface LoweredLocalAgentRuntime {
  readonly target: LocalAgentRuntimeTarget;
  readonly manifest: ResolvedRuntime["manifest"];
  readonly runtime: LocalAgentRuntime;
  readonly runtimeLedgerSource: LocalRuntimeLedgerSource;
  readonly submitWithProductLink: (
    input: LocalAgentSubmitInput,
    productLink: SubmitAgentProductLink,
  ) => Promise<SubmitResult>;
  readonly commitScheduleFireDispatch: (
    result: ScheduleFireDispatchResult,
  ) => Promise<ReadonlyArray<LedgerEvent>>;
  readonly commitScheduleFireDispatchWithDelivery: (
    result: ScheduleFireDeliveryDispatchResult,
  ) => Promise<ReadonlyArray<LedgerEvent>>;
}

export class LocalWorkspaceEnvError extends Error {
  override readonly name = "LocalWorkspaceEnvError";
}

export class LocalAgentRuntimeResolveError extends Error {
  override readonly name = "LocalAgentRuntimeResolveError";
  readonly diagnostics: ReadonlyArray<PreflightDiagnostic>;

  constructor(diagnostics: ReadonlyArray<PreflightDiagnostic>) {
    super(
      diagnostics.map((diagnostic) => diagnostic.reason).join("; ") ||
        "local agent runtime failed to resolve",
    );
    this.diagnostics = diagnostics;
  }
}

const textEncoder = new TextEncoder();

const defaultLocalLlmResponse: LlmResponse = {
  items: [{ type: "message", text: "ok" }],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
};

const defaultLocalLlmRoute: LlmRoute = {
  kind: "in-memory",
  endpointRef: "local",
  credentialRef: "local",
};

const utf8ByteLength = (value: string): number => textEncoder.encode(value).byteLength;

const cleanEnv = (source: Readonly<Record<string, string | undefined>>): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
};

const processEnvFor = (options: CreateLocalWorkspaceEnvOptions): Record<string, string> => ({
  ...(options.inheritEnv === true ? cleanEnv(process.env) : {}),
  ...(options.env === undefined ? {} : cleanEnv(options.env)),
});

const fileStatFor = (stat: Awaited<ReturnType<typeof fs.stat>>): WorkspaceFileStat => ({
  type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
  size: Number(stat.size),
  mtimeMs: Number(stat.mtimeMs),
});

const missingPath = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const rejectSymbolicRefs = (options: WorkspaceExecOptions): void => {
  if (options.envRefs !== undefined && Object.keys(options.envRefs).length > 0) {
    throw new LocalWorkspaceEnvError("local workspace env cannot resolve symbolic env refs");
  }
  if (options.materialRefs !== undefined && options.materialRefs.length > 0) {
    throw new LocalWorkspaceEnvError("local workspace env cannot resolve symbolic material refs");
  }
};

const appendOutput = (
  previous: string,
  chunk: string,
  maxBytes: number | undefined,
): { readonly text: string; readonly truncated: boolean } => {
  const next = `${previous}${chunk}`;
  if (maxBytes === undefined) return { text: next, truncated: false };
  const truncated = truncateUtf8(next, maxBytes);
  return { text: truncated.text, truncated: truncated.truncated };
};

const execLocalCommand = (
  command: string,
  options: WorkspaceExecOptions,
  env: Record<string, string>,
): Promise<WorkspaceExecResult> =>
  new Promise((resolve, reject) => {
    rejectSymbolicRefs(options);
    checkSignal(options.signal);
    const started = Date.now();
    const child = spawn(command, {
      cwd: options.cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      settle(() => reject(abortErrorFor(options.signal!)));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle(() =>
        reject(
          new LocalWorkspaceEnvError(
            `local workspace command timed out after ${options.timeoutMs}ms`,
          ),
        ),
      );
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += utf8ByteLength(chunk);
      const appended = appendOutput(stdout, chunk, options.maxOutputBytes);
      stdout = appended.text;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += utf8ByteLength(chunk);
      const appended = appendOutput(stderr, chunk, options.maxOutputBytes);
      stderr = appended.text;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (cause) => {
      settle(() => reject(new LocalWorkspaceEnvError(String(cause))));
    });
    child.on("close", (code) => {
      settle(() =>
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          stdoutBytes,
          stderrBytes,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - started,
        }),
      );
    });
  });

const localWorkspaceBackend = (options: CreateLocalWorkspaceEnvOptions): WorkspaceEnvBackend => {
  const env = processEnvFor(options);
  return {
    readFile: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.readFile(path, "utf8");
    },
    readFileBuffer: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return new Uint8Array(await fs.readFile(path));
    },
    writeFile: (path, content, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.writeFile(path, content);
    },
    stat: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fileStatFor(await fs.stat(path));
    },
    readdir: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.readdir(path);
    },
    exists: async (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      try {
        await fs.access(path, fsConstants.F_OK);
        return true;
      } catch (cause) {
        if (missingPath(cause)) return false;
        throw cause;
      }
    },
    mkdir: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.mkdir(path, { recursive: operationOptions?.recursive }).then(() => undefined);
    },
    rm: (path, operationOptions) => {
      checkSignal(operationOptions?.signal);
      return fs.rm(path, {
        recursive: operationOptions?.recursive,
        force: operationOptions?.force,
      });
    },
    exec: (command, execOptions) => execLocalCommand(command, execOptions, env),
  };
};

/**
 * Creates a Node/Bun local filesystem workspace environment.
 *
 * Path confinement is owned by the shared `createWorkspaceEnv` contract; this
 * backend only executes operations on paths it receives from that contract.
 *
 * @public
 */
export const createLocalWorkspaceEnv = (options: CreateLocalWorkspaceEnvOptions): WorkspaceEnv => {
  const cwd = normalizeAbsolutePath(options.cwd);
  return createWorkspaceEnv({
    domain: { kind: "workspace", ref: cwd },
    cwd,
    backend: localWorkspaceBackend(options),
  });
};

const localAgentHost = (target: LocalAgentRuntimeTarget, workspaceEnv: WorkspaceEnv) =>
  defineHost({
    target,
    provides: [WORKSPACE_OPERATION_HOST_FACT],
    materialize: () => ({
      [WORKSPACE_OPERATION_HOST_FACT]: () => workspaceEnv,
    }),
  });

const localWorkspaceSession = (input: {
  readonly target: LocalAgentRuntimeTarget;
  readonly identity: string;
  readonly workspaceEnv: WorkspaceEnv;
  readonly workspaceOperations?: WorkspaceOperationsOptions;
}): WorkspaceSessionLease =>
  defineWorkspaceSessionLease({
    identity: {
      scope: input.identity,
      runId: input.target,
      workspaceRef: input.workspaceEnv.domain.ref,
    },
    env: input.workspaceEnv,
    repo: { repoRef: input.workspaceEnv.cwd, root: input.workspaceEnv.cwd },
    permissions:
      input.workspaceOperations === undefined
        ? undefined
        : {
            phaseRef: input.target,
            policy: {
              ...(input.workspaceOperations.exposure === undefined
                ? {}
                : { exposure: input.workspaceOperations.exposure }),
              ...(input.workspaceOperations.toolNames === undefined
                ? {}
                : { toolNames: input.workspaceOperations.toolNames }),
              ...(input.workspaceOperations.mutationPolicy === undefined
                ? {}
                : { mutationPolicy: input.workspaceOperations.mutationPolicy }),
              ...(input.workspaceOperations.shellPolicy === undefined
                ? {}
                : { shellPolicy: input.workspaceOperations.shellPolicy }),
              ...(input.workspaceOperations.toolInteractions === undefined
                ? {}
                : { toolInteractions: input.workspaceOperations.toolInteractions }),
            },
          },
    resourceLimits: {
      ...(input.workspaceOperations?.maxFileBytes === undefined
        ? {}
        : { maxFileBytes: input.workspaceOperations.maxFileBytes }),
      ...(input.workspaceOperations?.maxCommandChars === undefined
        ? {}
        : { maxCommandChars: input.workspaceOperations.maxCommandChars }),
      ...(input.workspaceOperations?.execTimeoutMs === undefined
        ? {}
        : { execTimeoutMs: input.workspaceOperations.execTimeoutMs }),
      ...(input.workspaceOperations?.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: input.workspaceOperations.maxOutputBytes }),
    },
  });

const localWorkspaceOperations = (options: WorkspaceOperationsOptions | undefined) =>
  workspaceOperations({
    toolNames: WORKSPACE_TOOL_NAMES,
    mutationPolicy: "receipt-backed",
    shellPolicy: "receipt-backed",
    ...options,
  });

interface ResolvedLocalAgentRuntimeLlm {
  readonly transport: Layer.Layer<LlmTransport, never, RefResolverService>;
  readonly refResolver?: RefResolver;
  readonly defaultRoute: LlmRoute;
  readonly preflight?: LocalAgentRuntimeLlmPreflight;
}

const localLlmTestFixture = (
  options: LocalAgentRuntimeTestLlm | undefined,
): ResolvedLocalAgentRuntimeLlm => {
  const fixtureOptions: InMemoryLlmTransportOptions =
    options === undefined
      ? { responses: [defaultLocalLlmResponse] }
      : {
          ...(options.handler === undefined ? {} : { handler: options.handler }),
          ...(options.responses === undefined ? {} : { responses: options.responses }),
        };
  return {
    transport: InMemoryLlmTransportLive(fixtureOptions),
    defaultRoute: options?.route ?? defaultLocalLlmRoute,
  };
};

const localLlmAssembly = (
  options: LocalAgentRuntimeLlm | undefined,
): ResolvedLocalAgentRuntimeLlm => {
  if (options?.kind === "transport") {
    return {
      transport: options.transport,
      refResolver: options.refResolver,
      defaultRoute: options.route,
      preflight: options.preflight,
    };
  }
  return localLlmTestFixture(options);
};

const routeRequiresProviderPreflight = (route: LlmRoute): boolean =>
  route.kind === "openai-chat-compatible";

const localLlmPreflightDiagnostics = (
  llm: ResolvedLocalAgentRuntimeLlm,
  route: LlmRoute,
  routeBindingRef: string,
): ReadonlyArray<PreflightDiagnostic> => {
  if (llm.preflight !== undefined) {
    return llm.preflight({ route, refResolver: llm.refResolver, routeBindingRef });
  }
  if (!routeRequiresProviderPreflight(route)) return [];
  return [
    {
      pass: "provider_material",
      reason: "OpenAI-compatible local LLM routes require provider material preflight",
    },
  ];
};

const mergeToolContext = (
  base: SubmitToolContext | undefined,
  next: SubmitToolContext | undefined,
): SubmitToolContext | undefined =>
  base === undefined && next === undefined
    ? undefined
    : {
        extensions: {
          ...base?.extensions,
          ...next?.extensions,
        },
      };

const submitSpecWithBindings = (
  input: LocalAgentSubmitInput,
  bindings: AgentSubmitBindings,
  effectAuthorityRef: AuthorityRef,
  defaultRoute: LlmRoute,
): SubmitSpec => ({
  ...input,
  context: input.context ?? {},
  route: input.route ?? defaultRoute,
  effectAuthorityRef,
  tools: { ...bindings.tools, ...input.tools },
  dynamicCapabilityProjection:
    bindings.dynamicCapabilityProjection ?? input.dynamicCapabilityProjection,
  instructionFragments: bindings.instructionFragments ?? input.instructionFragments,
  executionDomains: [...(bindings.executionDomains ?? []), ...(input.executionDomains ?? [])],
  materials: { ...bindings.materials, ...input.materials },
  toolContext: mergeToolContext(bindings.toolContext, input.toolContext),
  toolIntents: [...(bindings.toolIntents ?? []), ...(input.toolIntents ?? [])],
  receiptBackedTools: {
    ...bindings.receiptBackedTools,
    ...input.receiptBackedTools,
  },
  decisionInterrupts: [...(bindings.decisionInterrupts ?? []), ...(input.decisionInterrupts ?? [])],
  executionIdentity: input.executionIdentity ?? bindings.executionIdentity,
});

const localAgentRuntimeTarget = (target: LocalAgentRuntimeTarget): LocalAgentRuntimeTarget => {
  if (target === "local@1" || target === "node@1") return target;
  throw new TypeError(`unsupported local agent runtime target: ${String(target)}`);
};

const inspectionBoundaryEventIdentities = (
  truthIdentity: ReturnType<typeof inMemoryConversationTruthIdentity>,
  bindings: AgentSubmitBindings,
) => {
  const intentOwners = new Map(
    (bindings.toolIntents ?? []).map((intent) => [intent.kind, intent.boundaryPackage.ownerId]),
  );
  const identities = new Map<
    string,
    {
      readonly scopeRef: typeof truthIdentity.scopeRef;
      readonly effectAuthorityRef: AuthorityRef;
      readonly factOwnerRef: string;
    }
  >();
  for (const [toolName, receiptBinding] of Object.entries(bindings.receiptBackedTools ?? {})) {
    const tool = bindings.tools?.[toolName];
    if (tool === undefined) continue;
    for (const intentKind of receiptBinding.intentKinds) {
      const factOwnerRef = intentOwners.get(intentKind);
      if (factOwnerRef === undefined) continue;
      const identity = {
        scopeRef: truthIdentity.scopeRef,
        effectAuthorityRef: tool.contract.effectAuthorityRef,
        factOwnerRef,
      };
      identities.set(JSON.stringify(identity), identity);
    }
  }
  return Array.from(identities.values());
};

const localInspectionEvents = (input: {
  readonly truthIdentity: ReturnType<typeof inMemoryConversationTruthIdentity>;
  readonly resolved: ResolvedRuntime;
}): ReadonlyArray<LedgerEvent> => {
  const rows = new Map<number, LedgerEvent>();
  for (const event of input.resolved.state.snapshot(input.truthIdentity)) {
    rows.set(event.id, event);
  }
  for (const identity of inspectionBoundaryEventIdentities(
    input.truthIdentity,
    input.resolved.bindings,
  )) {
    for (const event of input.resolved.state.eventSnapshot(identity)) {
      rows.set(event.id, event);
    }
  }
  return Array.from(rows.values()).sort((left, right) => left.id - right.id);
};

type LocalAgentRuntimeFacadeInput = {
  readonly identity: string;
  readonly truthIdentity: ReturnType<typeof inMemoryConversationTruthIdentity>;
  readonly host: HostProfile;
  readonly capabilities: ReadonlyArray<CapabilityContract>;
  readonly resolved: ResolvedRuntime;
  readonly llm: ResolvedLocalAgentRuntimeLlm;
  readonly defaultRoute: LlmRoute;
};

const submitLocalAgent = (
  input: LocalAgentRuntimeFacadeInput,
  submitInput: LocalAgentSubmitInput,
  productLink?: SubmitAgentProductLink,
): Promise<SubmitResult> => {
  const diagnostics = localLlmPreflightDiagnostics(
    input.llm,
    submitInput.route ?? input.defaultRoute,
    "submit",
  );
  if (diagnostics.length > 0) {
    return Promise.reject(new LocalAgentRuntimeResolveError(diagnostics));
  }
  return Effect.runPromise(
    submitAgentEffect(
      internalSubmitSpec(
        submitSpecWithBindings(
          submitInput,
          input.resolved.bindings,
          input.truthIdentity.effectAuthorityRef,
          input.defaultRoute,
        ),
        {
          scope: input.identity,
          scopeRef: input.truthIdentity.scopeRef,
        },
        { runtimeGraphStatus: input.resolved.installGraph.graphStatus },
      ),
      productLink === undefined ? {} : { productLink },
    ).pipe(Effect.provide(input.resolved.layer)),
  );
};

const commitLocalScheduleFireDispatch = (
  resolved: ResolvedRuntime,
  result: ScheduleFireDispatchResult,
): Promise<ReadonlyArray<LedgerEvent>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const events = yield* ledger.commitPrepared((tx) => {
        const requested = tx.append(result.requested);
        const outcomeShape = result.outcome(1);
        tx.append({
          kind: outcomeShape.kind,
          scopeRef: outcomeShape.scopeRef,
          effectAuthorityRef: outcomeShape.effectAuthorityRef,
          buildPayload: (context) => result.outcome(context.id(requested)).payload,
        });
      });
      return events as ReadonlyArray<LedgerEvent>;
    }).pipe(Effect.provide(resolved.layer)),
  );

const commitLocalScheduleFireDispatchWithDelivery = (
  resolved: ResolvedRuntime,
  result: ScheduleFireDeliveryDispatchResult,
): Promise<ReadonlyArray<LedgerEvent>> =>
  result.kind === "replay"
    ? Promise.resolve([])
    : Effect.runPromise(
        Effect.gen(function* () {
          const ledger = yield* Ledger;
          const events = yield* ledger.commitPrepared((tx) => {
            const deliveryRequested = tx.append(result.delivery.requested);
            const deliveryOutcomeShape = result.schedule.ok
              ? result.delivery.accept(1)
              : result.delivery.fail(1, {
                  reason: result.schedule.reason,
                  retryable: result.schedule.phase !== "contract",
                });
            tx.append({
              kind: deliveryOutcomeShape.kind,
              scopeRef: deliveryOutcomeShape.scopeRef,
              effectAuthorityRef: deliveryOutcomeShape.effectAuthorityRef,
              buildPayload: (context) =>
                result.schedule.ok
                  ? result.delivery.accept(context.id(deliveryRequested)).payload
                  : result.delivery.fail(context.id(deliveryRequested), {
                      reason: result.schedule.reason,
                      retryable: result.schedule.phase !== "contract",
                    }).payload,
            });
            const scheduleRequested = tx.append(result.schedule.requested);
            const scheduleOutcomeShape = result.schedule.outcome(1);
            tx.append({
              kind: scheduleOutcomeShape.kind,
              scopeRef: scheduleOutcomeShape.scopeRef,
              effectAuthorityRef: scheduleOutcomeShape.effectAuthorityRef,
              buildPayload: (context) =>
                result.schedule.outcome(context.id(scheduleRequested)).payload,
            });
          });
          return events as ReadonlyArray<LedgerEvent>;
        }).pipe(Effect.provide(resolved.layer)),
      );

const hydrateLocalRuntimeLedger = (
  input: Pick<LocalAgentRuntimeFacadeInput, "truthIdentity" | "resolved">,
  events: ReadonlyArray<LedgerEvent> | undefined,
): Promise<void> => {
  if (events === undefined || events.length === 0) return Promise.resolve();
  const hydrationError = validateLocalRuntimeLedgerHydrationEvents(events, input.truthIdentity);
  if (hydrationError !== null) return Promise.reject(hydrationError);
  return Effect.runPromise(
    input.resolved.state
      .commitProtocolEvents(
        events.map((event) => ({
          ts: event.ts,
          kind: event.kind,
          scopeRef: event.scopeRef,
          effectAuthorityRef: event.effectAuthorityRef,
          factOwnerRef: event.factOwnerRef,
          payload: event.payload,
        })),
      )
      .pipe(Effect.asVoid),
  );
};

const assertLocalInputRequestScope = (
  input: LocalAgentRuntimeFacadeInput,
  ref: WorkspaceAgentInspectInputRequestCommandInput["ref"],
): void => {
  if (scopeRefKey(ref.scopeRef) !== scopeRefKey(input.truthIdentity.scopeRef)) {
    throw new TypeError(`input request scope mismatch: ${scopeRefKey(ref.scopeRef)}`);
  }
};

const inspectLocalInputRequest = (
  input: LocalAgentRuntimeFacadeInput,
  spec: WorkspaceAgentInspectInputRequestCommandInput,
): Promise<InputRequestSettlement> => {
  try {
    assertLocalInputRequestScope(input, spec.ref);
    return Promise.resolve(
      projectInputRequestSettlement(input.resolved.state.snapshot(input.truthIdentity), spec.ref),
    );
  } catch (cause) {
    return Promise.reject(cause);
  }
};

const resumeLocalInputRequest = (
  input: LocalAgentRuntimeFacadeInput,
  spec: WorkspaceAgentResumeInputRequestCommandInput,
): Promise<SubmitResult> => {
  try {
    assertLocalInputRequestScope(input, spec.ref);
  } catch (cause) {
    return Promise.reject(cause);
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const boundaryEvents = yield* BoundaryEvents;
      const events = yield* ledger.events(input.truthIdentity);
      const chatInput = chatInputForInputRequestResume(events, spec.ref);
      if (chatInput === null) {
        return yield* Effect.fail(
          new TypeError("input request resume missing original chat input"),
        );
      }
      const gate = projectDecisionGate(events, spec.ref.gateRef);
      const inputRequest = projectInputRequest(events, spec.ref);
      if (gate.status === "requested" && inputRequest.status === "pending") {
        yield* boundaryEvents.commit(decisionGateBoundaryContract, DECISION_GATE_KIND.DECIDED, {
          gateRef: spec.ref.gateRef,
          decisionRef: spec.answer.decisionRef,
          decision: "approved",
          decidedBy: spec.decidedBy,
        });
      } else if (
        (gate.status === "approved" || gate.status === "consumed") &&
        gate.decision?.decisionRef === spec.answer.decisionRef
      ) {
        // Idempotent retry after DECIDED was persisted but before/while submit resumed.
      } else {
        return yield* Effect.fail(new TypeError(`input request is not resumable: ${gate.status}`));
      }
      return chatInput;
    }).pipe(Effect.provide(input.resolved.layer)),
  ).then((chatInput) =>
    submitLocalAgent(input, {
      intent: chatInput.intent,
      context: chatInput.context,
      resume: submitResumeDecisionFromInputRequestRef(spec.ref, spec.answer),
    }),
  );
};

const closeLocalInputRequest = (
  input: LocalAgentRuntimeFacadeInput,
  spec: WorkspaceAgentDecideInputRequestCommandInput,
): Promise<SubmitResult> => {
  const closeDecision = spec.decision;
  if (closeDecision.kind === "approved") {
    return Promise.reject(new TypeError("approved input requests must resume"));
  }
  try {
    assertLocalInputRequestScope(input, spec.ref);
  } catch (cause) {
    return Promise.reject(cause);
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const ledger = yield* Ledger;
      const boundaryEvents = yield* BoundaryEvents;
      const events = yield* ledger.events(input.truthIdentity);
      const gate = projectDecisionGate(events, spec.ref.gateRef);
      const inputRequest = projectInputRequest(events, spec.ref);
      const resultFromLedger = () => {
        const result = projectSubmitResult(events, spec.ref.runId);
        return result === null
          ? Effect.fail(new TypeError("input request close missing terminal run fact"))
          : Effect.succeed(result);
      };
      const sameTerminal =
        (closeDecision.kind === "rejected" &&
          gate.status === "rejected" &&
          gate.decision?.decisionRef === closeDecision.decisionRef) ||
        (closeDecision.kind === "cancelled" &&
          gate.status === "cancelled" &&
          gate.cancelled?.closeRef === closeDecision.closeRef) ||
        (closeDecision.kind === "expired" &&
          gate.status === "expired" &&
          gate.expired?.closeRef === closeDecision.closeRef);
      if (sameTerminal) {
        return yield* resultFromLedger();
      }
      if (gate.status !== "requested" || inputRequest.status !== "pending") {
        return yield* Effect.fail(new TypeError(`input request terminal conflict: ${gate.status}`));
      }
      const terminal =
        closeDecision.kind === "rejected"
          ? {
              event: DECISION_GATE_KIND.DECIDED,
              payload: {
                gateRef: spec.ref.gateRef,
                decisionRef: closeDecision.decisionRef,
                decision: "rejected",
                decidedBy: closeDecision.decidedBy,
                reason: closeDecision.reason ?? "rejected",
                rejectionRef: {
                  rejectionId: decisionGateSettlementRef(
                    "rejected",
                    spec.ref.gateRef,
                    closeDecision.decisionRef,
                  ),
                  rejectionKind: "policy_denied",
                  reason: closeDecision.reason ?? "rejected",
                },
              },
              abortKind: ABORT.DECISION_REJECTED,
              terminalRef: closeDecision.decisionRef,
              reason: "rejected",
            }
          : closeDecision.kind === "cancelled"
            ? {
                event: DECISION_GATE_KIND.CANCELLED,
                payload: {
                  gateRef: spec.ref.gateRef,
                  closeRef: closeDecision.closeRef,
                  reason: closeDecision.reason ?? "cancelled",
                },
                abortKind: ABORT.DECISION_CANCELLED,
                terminalRef: closeDecision.closeRef,
                reason: "cancelled",
              }
            : {
                event: DECISION_GATE_KIND.EXPIRED,
                payload: {
                  gateRef: spec.ref.gateRef,
                  closeRef: closeDecision.closeRef,
                  reason: closeDecision.reason ?? "expired",
                },
                abortKind: ABORT.DECISION_EXPIRED,
                terminalRef: closeDecision.closeRef,
                reason: "expired",
              };
      yield* boundaryEvents.commitWithRuntimeEvents(
        decisionGateBoundaryContract,
        terminal.event,
        terminal.payload,
        () => [
          agentRunAbortedEvent({
            scopeRef: input.truthIdentity.scopeRef,
            effectAuthorityRef: input.truthIdentity.effectAuthorityRef,
            kind: terminal.abortKind as AbortKind,
            runId: spec.ref.runId,
            tokensUsed: inputRequest.interruption.payload.tokensUsed,
            payload: {
              reason: terminal.reason,
              gateRef: spec.ref.gateRef,
              terminalRef: terminal.terminalRef,
            },
            traceContext: inputRequest.interruption.payload.traceContext,
          }),
        ],
      );
      const nextEvents = yield* ledger.events(input.truthIdentity);
      const result = projectSubmitResult(nextEvents, spec.ref.runId);
      return result === null
        ? yield* Effect.fail(new TypeError("input request close missing terminal run fact"))
        : result;
    }).pipe(Effect.provide(input.resolved.layer)),
  );
};

const decideLocalInputRequest = (
  input: LocalAgentRuntimeFacadeInput,
  spec: WorkspaceAgentDecideInputRequestCommandInput,
): Promise<SubmitResult> =>
  spec.decision.kind === "approved"
    ? resumeLocalInputRequest(input, {
        ref: spec.ref,
        decidedBy: spec.decision.decidedBy,
        answer: spec.decision.answer,
      })
    : closeLocalInputRequest(input, spec);

const localAgentRuntimeFacade = (input: LocalAgentRuntimeFacadeInput): LocalAgentRuntime => ({
  submit: (submitInput) => submitLocalAgent(input, submitInput),
  resumeInputRequest: (spec) => resumeLocalInputRequest(input, spec),
  decideInputRequest: (spec) => decideLocalInputRequest(input, spec),
  inspectInputRequest: (spec) => inspectLocalInputRequest(input, spec),
  events: (opts = {}) => input.resolved.state.snapshot(input.truthIdentity, opts),
  diagnostics: () => input.resolved.state.telemetryDiagnostics(),
  inspect: () =>
    projectInspectionSnapshot({
      resolved: input.resolved,
      host: input.host,
      capabilities: input.capabilities,
      runtime: {
        status: "available",
        events: localInspectionEvents({
          truthIdentity: input.truthIdentity,
          resolved: input.resolved,
        }),
        diagnostics: input.resolved.state.telemetryDiagnostics(),
      },
    }),
});

/**
 * Lowers local runtime options into the same submit/events/diagnostics facade
 * used by dev/test and generated product targets.
 *
 * @public
 */
export const lowerLocalAgentRuntime = async (
  options: LowerLocalAgentRuntimeOptions,
): Promise<LoweredLocalAgentRuntime> => {
  const target = localAgentRuntimeTarget(options.target);
  const identity = options.truthIdentity ?? inMemoryConversationTruthIdentity(options.identity);
  const llm = localLlmAssembly(options.llm);
  const llmPreflightDiagnostics = localLlmPreflightDiagnostics(llm, llm.defaultRoute, "default");
  if (llmPreflightDiagnostics.length > 0) {
    throw new LocalAgentRuntimeResolveError(llmPreflightDiagnostics);
  }
  const workspaceEnv = createLocalWorkspaceEnv({
    cwd: options.cwd,
    env: options.env,
    inheritEnv: options.inheritEnv,
  });
  const workspaceSession = localWorkspaceSession({
    target,
    identity: options.identity,
    workspaceEnv,
    workspaceOperations: options.workspaceOperations,
  });
  const host = localAgentHost(target, workspaceSession.env);
  const capabilities = [
    localWorkspaceOperations(options.workspaceOperations),
    ...(options.capabilities ?? []),
  ];
  const resolved = await resolveRuntime(host, capabilities, {
    identity: options.identity,
    llmTransport: llm.transport,
    refResolver: llm.refResolver,
  });
  if (!resolved.ok) {
    throw new LocalAgentRuntimeResolveError(resolved.diagnostics);
  }
  const facadeInput = {
    identity: options.identity,
    truthIdentity: identity,
    host,
    capabilities,
    resolved: resolved.resolved,
    llm,
    defaultRoute: llm.defaultRoute,
  } satisfies LocalAgentRuntimeFacadeInput;
  await hydrateLocalRuntimeLedger(facadeInput, options.initialEvents);
  const runtime = localAgentRuntimeFacade(facadeInput);
  return {
    target,
    manifest: resolved.resolved.manifest,
    runtime,
    runtimeLedgerSource: createLocalRuntimeLedgerSource({
      events: () => runtime.events(),
      diagnostics: () => runtime.diagnostics(),
    }),
    submitWithProductLink: (submitInput, productLink) =>
      submitLocalAgent(facadeInput, submitInput, productLink),
    commitScheduleFireDispatch: (result) =>
      commitLocalScheduleFireDispatch(resolved.resolved, result),
    commitScheduleFireDispatchWithDelivery: (result) =>
      commitLocalScheduleFireDispatchWithDelivery(resolved.resolved, result),
  };
};

/**
 * Creates a local dev/test runtime from the same capability resolver used by
 * production hosts.
 *
 * @public
 */
export const createLocalAgentRuntime = async (
  options: CreateLocalAgentRuntimeOptions,
): Promise<LocalAgentRuntime> => {
  const lowered = await lowerLocalAgentRuntime({ ...options, target: "local@1" });
  return lowered.runtime;
};
