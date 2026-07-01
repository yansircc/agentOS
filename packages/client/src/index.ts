import {
  continuationRefFromInterruptedEvent,
  decodeRuntimeLedgerEvent as decodeRuntimeLedgerProtocolEvent,
  inputRequestRefFromInterruptedEvent,
  RUNTIME_ABORT_EVENT_KINDS,
  RUNTIME_EVENT_KIND,
  type InputRequestDescriptor,
  type RecordedContinuationRef,
  type RecordedInputRequestRef,
  type RuntimeLedgerEvent,
  type RuntimeLedgerEventByKind,
} from "@agent-os/core/runtime-protocol";
import { parseBackendProtocolLedgerEventRpc } from "@agent-os/core/backend-protocol";
import type {
  RunCancellationStatus,
  RunLastKnownEvent,
  RunProductLink,
  RunRequestStatus,
} from "@agent-os/core/types";
import { ABORT } from "@agent-os/core/abort";

export type AgentClientListener = () => void;
export type AgentClientUnsubscribe = () => void;

export interface AgentClientStore<Snapshot> {
  subscribe(listener: AgentClientListener): AgentClientUnsubscribe;
  getSnapshot(): Snapshot;
}

export interface AgentClientStoreController<Snapshot> extends AgentClientStore<Snapshot> {
  setSnapshot(snapshot: Snapshot): void;
}

export type AgentClientSelector<Snapshot, Selected> = (snapshot: Snapshot) => Selected;

export const createAgentClientStore = <Snapshot>(
  initialSnapshot: Snapshot,
): AgentClientStoreController<Snapshot> => {
  let snapshot = initialSnapshot;
  const listeners = new Set<AgentClientListener>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    setSnapshot(nextSnapshot) {
      if (Object.is(snapshot, nextSnapshot)) return;
      snapshot = nextSnapshot;
      for (const listener of listeners) listener();
    },
  };
};

export const selectAgentClientSnapshot = <Snapshot, Selected>(
  store: AgentClientStore<Snapshot>,
  selector: AgentClientSelector<Snapshot, Selected>,
): Selected => selector(store.getSnapshot());

export type AgentClientConnectionStatus = "idle" | "connecting" | "open" | "closed" | "failed";
export type AgentClientRunStatus = "idle" | "running" | "interrupted" | "completed" | "aborted";

export interface AgentClientConnectionSnapshot {
  readonly status: AgentClientConnectionStatus;
  readonly error?: string;
}

export interface AgentClientInputRequestSnapshot {
  readonly ref: RecordedInputRequestRef;
  readonly descriptor: InputRequestDescriptor;
  readonly status: "pending" | "resumed";
  readonly resumedAtEventId?: number;
}

export interface AgentClientRunSnapshot {
  readonly status: AgentClientRunStatus;
  readonly runId?: number;
  readonly activeContinuationRef?: RecordedContinuationRef;
  readonly pendingContinuations: ReadonlyArray<RecordedContinuationRef>;
  readonly inputRequests: ReadonlyArray<AgentClientInputRequestSnapshot>;
}

export interface AgentClientSnapshot {
  readonly events: ReadonlyArray<RuntimeLedgerEvent>;
  readonly lastEventId?: number;
  readonly connection: AgentClientConnectionSnapshot;
  readonly run: AgentClientRunSnapshot;
}

export interface AgentClientRunInspectionSnapshot {
  readonly runId?: number;
  readonly status: AgentClientRunStatus;
  readonly lastKnownEvent?: RunLastKnownEvent;
  readonly request: RunRequestStatus;
  readonly cancellation: RunCancellationStatus;
  readonly productLink?: RunProductLink;
}

export interface AgentClientStreamCursor {
  readonly afterEventId?: number;
}

export interface AgentClientStreamOptions {
  readonly signal?: AbortSignal;
}

export interface AgentClientStreamSource {
  open(
    cursor: AgentClientStreamCursor,
    options?: AgentClientStreamOptions,
  ): AsyncIterable<RuntimeLedgerEvent>;
}

export type AgentClientRuntimeLedgerDecodeFailureReason =
  | "ledger_event_malformed"
  | "non_runtime_event"
  | "runtime_payload_invalid"
  | "sse_data_invalid_json";

export interface AgentClientRuntimeLedgerDecodeFailure {
  readonly _tag: "agent_os.client.runtime_ledger_event_decode_failure";
  readonly reason: AgentClientRuntimeLedgerDecodeFailureReason;
  readonly message: string;
}

export type AgentClientRuntimeLedgerDecodeResult =
  | { readonly ok: true; readonly event: RuntimeLedgerEvent }
  | { readonly ok: false; readonly failure: AgentClientRuntimeLedgerDecodeFailure };

export class AgentClientRuntimeLedgerDecodeError extends Error {
  readonly failure: AgentClientRuntimeLedgerDecodeFailure;

  constructor(failure: AgentClientRuntimeLedgerDecodeFailure) {
    super(failure.message);
    this.name = "AgentClientRuntimeLedgerDecodeError";
    this.failure = failure;
  }
}

export interface AgentClientLedgerEventRpcStreamSource {
  open(cursor: AgentClientStreamCursor, options?: AgentClientStreamOptions): AsyncIterable<unknown>;
}

export interface AgentClientSseEvent {
  readonly data: string;
}

export interface AgentClientSseStreamSource {
  open(
    cursor: AgentClientStreamCursor,
    options?: AgentClientStreamOptions,
  ): AsyncIterable<AgentClientSseEvent>;
}

export interface AgentClientCommandOptions {
  readonly signal?: AbortSignal;
}

export interface AgentClientCommandSpec<Input = unknown, Output = unknown> {
  readonly input: Input;
  readonly output: Output;
}

export type AgentClientCommandMap = {
  readonly [command: string]: AgentClientCommandSpec;
};

export type AgentClientRpcInvoker<Commands extends AgentClientCommandMap = AgentClientCommandMap> =
  <Name extends Extract<keyof Commands, string>>(
    name: Name,
    input: Commands[Name]["input"],
    options?: AgentClientCommandOptions,
  ) => Promise<Commands[Name]["output"]>;

export interface CreateAgentClientOptions<
  Commands extends AgentClientCommandMap = AgentClientCommandMap,
> {
  readonly initialEvents?: ReadonlyArray<RuntimeLedgerEvent>;
  readonly streamSource?: AgentClientStreamSource;
  readonly rpcInvoker?: AgentClientRpcInvoker<Commands>;
}

export interface AgentClientController<
  Commands extends AgentClientCommandMap = AgentClientCommandMap,
> extends AgentClientStore<AgentClientSnapshot> {
  readonly invoke: AgentClientRpcInvoker<Commands>;
  appendEvents(events: ReadonlyArray<RuntimeLedgerEvent>): void;
  connect(options?: AgentClientStreamOptions): Promise<void>;
  disconnect(): void;
}

const INITIAL_CONNECTION: AgentClientConnectionSnapshot = { status: "idle" };
const INITIAL_RUN: AgentClientRunSnapshot = {
  status: "idle",
  pendingContinuations: [],
  inputRequests: [],
};

const runtimeLedgerDecodeFailure = (
  reason: AgentClientRuntimeLedgerDecodeFailureReason,
  message: string,
): AgentClientRuntimeLedgerDecodeFailure => ({
  _tag: "agent_os.client.runtime_ledger_event_decode_failure",
  reason,
  message,
});

const runtimeLedgerDecodeError = (
  failure: AgentClientRuntimeLedgerDecodeFailure,
): AgentClientRuntimeLedgerDecodeError => new AgentClientRuntimeLedgerDecodeError(failure);

export const decodeAgentClientRuntimeLedgerEvent = (
  value: unknown,
): AgentClientRuntimeLedgerDecodeResult => {
  const parsed = parseBackendProtocolLedgerEventRpc(value);
  if (!parsed.ok) {
    return {
      ok: false,
      failure: runtimeLedgerDecodeFailure("ledger_event_malformed", parsed.failure.reason),
    };
  }

  try {
    const decoded = decodeRuntimeLedgerProtocolEvent(parsed.value);
    if (decoded._tag === "non_runtime") {
      return {
        ok: false,
        failure: runtimeLedgerDecodeFailure(
          "non_runtime_event",
          "ledger event kind is not owned by runtime protocol",
        ),
      };
    }
    return { ok: true, event: decoded.event };
  } catch {
    return {
      ok: false,
      failure: runtimeLedgerDecodeFailure(
        "runtime_payload_invalid",
        "runtime ledger event payload failed runtime-protocol decode",
      ),
    };
  }
};

export const decodeAgentClientRuntimeLedgerSseEvent = (
  frame: AgentClientSseEvent,
): AgentClientRuntimeLedgerDecodeResult => {
  try {
    return decodeAgentClientRuntimeLedgerEvent(JSON.parse(frame.data) as unknown);
  } catch {
    return {
      ok: false,
      failure: runtimeLedgerDecodeFailure(
        "sse_data_invalid_json",
        "runtime ledger SSE data must be JSON",
      ),
    };
  }
};

const decodeRuntimeLedgerStream = async function* <Wire>(
  source: AsyncIterable<Wire>,
  decode: (value: Wire) => AgentClientRuntimeLedgerDecodeResult,
): AsyncIterable<RuntimeLedgerEvent> {
  for await (const value of source) {
    const decoded = decode(value);
    if (!decoded.ok) throw runtimeLedgerDecodeError(decoded.failure);
    yield decoded.event;
  }
};

export const createAgentClientRuntimeLedgerStreamSource = (
  source: AgentClientLedgerEventRpcStreamSource,
): AgentClientStreamSource => ({
  open(cursor, options) {
    return decodeRuntimeLedgerStream(
      source.open(cursor, options),
      decodeAgentClientRuntimeLedgerEvent,
    );
  },
});

export const createAgentClientRuntimeLedgerSseStreamSource = (
  source: AgentClientSseStreamSource,
): AgentClientStreamSource => ({
  open(cursor, options) {
    return decodeRuntimeLedgerStream(
      source.open(cursor, options),
      decodeAgentClientRuntimeLedgerSseEvent,
    );
  },
});

export const createInitialAgentClientSnapshot = (
  events: ReadonlyArray<RuntimeLedgerEvent> = [],
): AgentClientSnapshot =>
  appendRuntimeEventsToSnapshot(
    {
      events: [],
      connection: INITIAL_CONNECTION,
      run: INITIAL_RUN,
    },
    events,
  );

const isInterruptedEvent = (
  event: RuntimeLedgerEvent,
): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED> =>
  event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED;

const isResumedEvent = (
  event: RuntimeLedgerEvent,
): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED> =>
  event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED;

const isTerminalAbortEvent = (event: RuntimeLedgerEvent): boolean =>
  RUNTIME_ABORT_EVENT_KINDS.includes(event.kind as (typeof RUNTIME_ABORT_EVENT_KINDS)[number]);

const runIdFromEvent = (event: RuntimeLedgerEvent): number | undefined => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return event.id;
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
    case RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS:
    case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED:
    case RUNTIME_EVENT_KIND.RUNTIME_REKEYED:
      return event.payload.runId;
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      return event.payload.runtimeRunId;
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_REQUESTED:
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_ACCEPTED:
    case RUNTIME_EVENT_KIND.INGRESS_DELIVERY_FAILED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED:
      return undefined;
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return event.payload.turn.id;
    default:
      return isTerminalAbortEvent(event) ? event.payload.runId : undefined;
  }
};

const productLinkFromEvent = (
  event: RuntimeLedgerEvent,
  runId: number,
): RunProductLink | undefined => {
  if (
    event.kind === RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED &&
    event.payload.runtimeRunId === runId
  ) {
    return {
      kind: "session_turn",
      eventId: event.id,
      submittedAt: event.ts,
      sessionRef: event.payload.sessionRef,
      turnRef: event.payload.turnRef,
      ...(event.payload.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: event.payload.idempotencyKey }),
    };
  }
  if (
    event.kind === RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED &&
    event.payload.runtimeRunId === runId
  ) {
    return {
      kind: "workflow_run",
      eventId: event.id,
      submittedAt: event.ts,
      workflowId: event.payload.workflowId,
      workflowRunId: event.payload.workflowRunId,
      ...(event.payload.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: event.payload.idempotencyKey }),
      ...(event.payload.inputDigest === undefined
        ? {}
        : { inputDigest: event.payload.inputDigest }),
    };
  }
  return undefined;
};

const refKey = (ref: {
  readonly kind: string;
  readonly scopeRef: unknown;
  readonly afterEventId: number;
}): string => `${ref.kind}:${JSON.stringify(ref.scopeRef)}:${ref.afterEventId}`;

const eventMatchesResume = (
  event: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED>,
  ref: { readonly runId: number; readonly interruptId: string },
): boolean => event.payload.runId === ref.runId && event.payload.interruptId === ref.interruptId;

const applyRuntimeEvent = (
  run: AgentClientRunSnapshot,
  event: RuntimeLedgerEvent,
): AgentClientRunSnapshot => {
  const runId = runIdFromEvent(event);
  const baseRun = runId === undefined ? run : { ...run, runId };

  if (isInterruptedEvent(event)) {
    const continuation = continuationRefFromInterruptedEvent(event);
    const inputRequest = inputRequestRefFromInterruptedEvent(event);
    const pendingContinuations =
      continuation.ok &&
      !baseRun.pendingContinuations.some((ref) => refKey(ref) === refKey(continuation.ref))
        ? [...baseRun.pendingContinuations, continuation.ref]
        : baseRun.pendingContinuations;
    const inputRequests =
      inputRequest.ok &&
      !baseRun.inputRequests.some((request) => refKey(request.ref) === refKey(inputRequest.ref))
        ? [
            ...baseRun.inputRequests,
            {
              ref: inputRequest.ref,
              descriptor: inputRequest.descriptor,
              status: "pending" as const,
            },
          ]
        : baseRun.inputRequests;
    const { activeContinuationRef: _staleActiveContinuationRef, ...runWithoutActive } = baseRun;
    return {
      ...runWithoutActive,
      status: "interrupted",
      ...(continuation.ok ? { activeContinuationRef: continuation.ref } : {}),
      pendingContinuations,
      inputRequests,
    };
  }

  if (isResumedEvent(event)) {
    const pendingContinuations = baseRun.pendingContinuations.filter(
      (ref) => !eventMatchesResume(event, ref),
    );
    const inputRequests = baseRun.inputRequests.map((request) =>
      eventMatchesResume(event, request.ref)
        ? { ...request, status: "resumed" as const, resumedAtEventId: event.id }
        : request,
    );
    const activeContinuationRef =
      baseRun.activeContinuationRef !== undefined &&
      eventMatchesResume(event, baseRun.activeContinuationRef)
        ? undefined
        : baseRun.activeContinuationRef;
    if (activeContinuationRef === undefined) {
      const { activeContinuationRef: _consumedActiveContinuationRef, ...runWithoutActive } =
        baseRun;
      return {
        ...runWithoutActive,
        status: "running",
        pendingContinuations,
        inputRequests,
      };
    }
    return {
      ...baseRun,
      status: "running",
      activeContinuationRef,
      pendingContinuations,
      inputRequests,
    };
  }

  if (
    event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED ||
    event.kind === RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS
  ) {
    const { activeContinuationRef: _completedActiveContinuationRef, ...runWithoutActive } = baseRun;
    return { ...runWithoutActive, status: "completed", pendingContinuations: [] };
  }

  if (isTerminalAbortEvent(event)) {
    const { activeContinuationRef: _abortedActiveContinuationRef, ...runWithoutActive } = baseRun;
    return { ...runWithoutActive, status: "aborted", pendingContinuations: [] };
  }

  return runId === undefined ? baseRun : { ...baseRun, status: "running" };
};

export const appendRuntimeEventsToSnapshot = (
  snapshot: AgentClientSnapshot,
  events: ReadonlyArray<RuntimeLedgerEvent>,
): AgentClientSnapshot => {
  if (events.length === 0) return snapshot;
  const seenEventIds = new Set(snapshot.events.map((event) => event.id));
  const nextEvents: RuntimeLedgerEvent[] = [...snapshot.events];
  let nextRun = snapshot.run;
  let lastEventId = snapshot.lastEventId;
  let changed = false;

  for (const event of events) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    nextEvents.push(event);
    nextRun = applyRuntimeEvent(nextRun, event);
    lastEventId = lastEventId === undefined ? event.id : Math.max(lastEventId, event.id);
    changed = true;
  }

  if (!changed) return snapshot;
  return {
    ...snapshot,
    events: nextEvents,
    lastEventId,
    run: nextRun,
  };
};

export const isCurrentContinuationRef = (
  snapshot: AgentClientSnapshot,
  ref: RecordedContinuationRef,
): boolean =>
  snapshot.run.pendingContinuations.some((candidate) => refKey(candidate) === refKey(ref));

export const isCurrentInputRequestRef = (
  snapshot: AgentClientSnapshot,
  ref: RecordedInputRequestRef,
): boolean =>
  snapshot.run.inputRequests.some(
    (request) => request.status === "pending" && refKey(request.ref) === refKey(ref),
  );

const payloadReason = (event: RuntimeLedgerEvent): string | undefined => {
  const payload = event.payload as { readonly reason?: unknown };
  return typeof payload.reason === "string" && payload.reason.length > 0
    ? payload.reason
    : undefined;
};

export const projectAgentClientRunInspection = (
  snapshot: AgentClientSnapshot,
): AgentClientRunInspectionSnapshot => {
  const runId = snapshot.run.runId;
  if (runId === undefined) {
    return {
      status: snapshot.run.status,
      request: { kind: "none" },
      cancellation: { kind: "none" },
    };
  }
  const runEvents = snapshot.events.filter((event) => runIdFromEvent(event) === runId);
  const last = runEvents.sort((left, right) => right.id - left.id)[0];
  const cancellationEvent = runEvents.find((event) => event.kind === ABORT.DECISION_CANCELLED);
  const activeInputRequest = snapshot.run.inputRequests.find(
    (request) => request.status === "pending",
  );
  const activeContinuation = snapshot.run.activeContinuationRef;
  const activeInterruption = snapshot.events.find(
    (event): event is RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED> =>
      event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED &&
      event.payload.runId === runId &&
      event.payload.interruptId === activeContinuation?.interruptId,
  );
  const productLink = snapshot.events
    .map((event) => productLinkFromEvent(event, runId))
    .find((candidate): candidate is RunProductLink => candidate !== undefined);
  return {
    runId,
    status: snapshot.run.status,
    ...(last === undefined
      ? {}
      : { lastKnownEvent: { id: last.id, ts: last.ts, kind: last.kind } }),
    request:
      snapshot.run.status === "interrupted" && activeInterruption !== undefined
        ? {
            kind: "waiting_for_input",
            interruptId: activeInterruption.payload.interruptId,
            reason: activeInterruption.payload.reason,
            at: activeInterruption.ts,
            ...(activeInputRequest === undefined
              ? {}
              : { descriptor: activeInputRequest.descriptor }),
          }
        : { kind: "none" },
    cancellation:
      cancellationEvent === undefined
        ? { kind: "none" }
        : {
            kind: "cancelled",
            at: cancellationEvent.ts,
            event: cancellationEvent.kind,
            ...(payloadReason(cancellationEvent) === undefined
              ? {}
              : { reason: payloadReason(cancellationEvent) }),
          },
    ...(productLink === undefined ? {} : { productLink }),
  };
};

const connectionSnapshot = (
  status: AgentClientConnectionStatus,
  error?: unknown,
): AgentClientConnectionSnapshot =>
  error === undefined ? { status } : { status, error: errorMessage(error) };

const errorMessage = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "unknown_error";
};

const setConnection = (
  snapshot: AgentClientSnapshot,
  status: AgentClientConnectionStatus,
  error?: unknown,
): AgentClientSnapshot => ({
  ...snapshot,
  connection: connectionSnapshot(status, error),
});

export const createAgentClient = <Commands extends AgentClientCommandMap = AgentClientCommandMap>(
  options: CreateAgentClientOptions<Commands> = {},
): AgentClientController<Commands> => {
  const store = createAgentClientStore(createInitialAgentClientSnapshot(options.initialEvents));
  let activeStreamAbort: AbortController | undefined;

  const setSnapshot = (snapshot: AgentClientSnapshot) => {
    store.setSnapshot(snapshot);
  };

  const appendEvents = (events: ReadonlyArray<RuntimeLedgerEvent>) => {
    setSnapshot(appendRuntimeEventsToSnapshot(store.getSnapshot(), events));
  };

  const invoke: AgentClientRpcInvoker<Commands> = (name, input, commandOptions) => {
    if (options.rpcInvoker === undefined) {
      return Promise.reject(new Error(`missing rpcInvoker for command ${name}`));
    }
    return options.rpcInvoker(name, input, commandOptions);
  };

  return {
    subscribe(listener) {
      return store.subscribe(listener);
    },
    getSnapshot() {
      return store.getSnapshot();
    },
    invoke,
    appendEvents,
    async connect(connectOptions) {
      if (options.streamSource === undefined) {
        throw new Error("missing streamSource");
      }
      if (connectOptions?.signal?.aborted === true) {
        setSnapshot(setConnection(store.getSnapshot(), "closed"));
        return;
      }

      activeStreamAbort?.abort();
      const streamAbort = new AbortController();
      activeStreamAbort = streamAbort;
      const abortFromCaller = () => streamAbort.abort(connectOptions?.signal?.reason);
      connectOptions?.signal?.addEventListener("abort", abortFromCaller, { once: true });

      try {
        setSnapshot(setConnection(store.getSnapshot(), "connecting"));
        const cursor = { afterEventId: store.getSnapshot().lastEventId };
        const stream = options.streamSource.open(cursor, { signal: streamAbort.signal });
        setSnapshot(setConnection(store.getSnapshot(), "open"));
        for await (const event of stream) {
          if (streamAbort.signal.aborted) break;
          appendEvents([event]);
        }
        setSnapshot(setConnection(store.getSnapshot(), "closed"));
      } catch (error) {
        if (streamAbort.signal.aborted) {
          setSnapshot(setConnection(store.getSnapshot(), "closed"));
        } else {
          setSnapshot(setConnection(store.getSnapshot(), "failed", error));
        }
      } finally {
        connectOptions?.signal?.removeEventListener("abort", abortFromCaller);
        if (activeStreamAbort === streamAbort) activeStreamAbort = undefined;
      }
    },
    disconnect() {
      activeStreamAbort?.abort();
      activeStreamAbort = undefined;
      setSnapshot(setConnection(store.getSnapshot(), "closed"));
    },
  };
};
