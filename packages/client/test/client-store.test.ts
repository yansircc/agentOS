import { describe, expect, it } from "vite-plus/test";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  agentSessionTurnSubmittedEvent,
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  decodeRuntimeLedgerEvent,
  RUNTIME_FACT_OWNER,
  type RuntimeEventCommitSpec,
  type RuntimeLedgerEvent,
} from "@agent-os/core/runtime-protocol";
import {
  appendRuntimeEventsToSnapshot,
  createAgentClient,
  createAgentClientStore,
  createAgentClientRuntimeLedgerSseStreamSource,
  createAgentClientRuntimeLedgerStreamSource,
  decodeAgentClientRuntimeLedgerEvent,
  decodeAgentClientRuntimeLedgerSseEvent,
  isCurrentContinuationRef,
  isCurrentInputRequestRef,
  projectAgentClientRunInspection,
  selectAgentClientSnapshot,
  type AgentClientCommandSpec,
  type AgentClientStreamSource,
} from "../src/index";
import { ABORT } from "@agent-os/core/abort";
import {
  createWorkspaceAgentClientBridge,
  WORKSPACE_AGENT_COMMAND,
  WORKSPACE_AGENT_PRODUCT_COMMAND,
  type WorkspaceAgentProductProjectionTypes,
} from "../src/workspace-agent";

const identity = {
  scopeRef: { kind: "session" as const, scopeId: "client-test" },
  effectAuthorityRef: { authorityClass: "test", authorityId: "client-test" },
};

const runtimeLedgerRpc = (id: number, spec: RuntimeEventCommitSpec): LedgerEvent => ({
  id,
  ts: id * 10,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  factOwnerRef: RUNTIME_FACT_OWNER,
  effectAuthorityRef: spec.effectAuthorityRef,
  payload: spec.payload,
});

const runtimeEvent = (id: number, spec: RuntimeEventCommitSpec): RuntimeLedgerEvent => {
  const decoded = decodeRuntimeLedgerEvent(runtimeLedgerRpc(id, spec));
  if (decoded._tag !== "runtime") expect.fail("expected runtime event");
  return decoded.event;
};

const startedEventSpec = (): RuntimeEventCommitSpec =>
  agentRunStartedEvent({ ...identity, intent: "test" });

const startedEvent = (id = 1): RuntimeLedgerEvent => runtimeEvent(id, startedEventSpec());

const interruptedEventSpec = (): RuntimeEventCommitSpec =>
  agentRunInterruptedEvent({
    ...identity,
    runId: 1,
    turn: { id: 1, index: 0 },
    interruptId: "interrupt-1",
    reason: "approval_required",
    resumeSchema: { type: "object" },
    tokensUsed: 10,
    decision: {
      gateRef: "gate-1",
      subjectRef: "subject-1",
      toolCallId: "tool-call-1",
      toolName: "write_file",
    },
  });

const interruptedEvent = (id = 2): RuntimeLedgerEvent => runtimeEvent(id, interruptedEventSpec());

const resumedEventSpec = (): RuntimeEventCommitSpec =>
  agentRunResumedEvent({
    ...identity,
    runId: 1,
    turn: { id: 1, index: 0 },
    interruptId: "interrupt-1",
    resume: { kind: "approval", approved: true },
    resumedAtEventId: 4,
  });

const resumedEvent = (id = 3): RuntimeLedgerEvent => runtimeEvent(id, resumedEventSpec());

const completedEventSpec = (): RuntimeEventCommitSpec =>
  agentRunCompletedEvent({
    ...identity,
    runId: 1,
    final: "done",
    output: "done",
    outputKind: "text",
    tokensUsed: 11,
  });

const completedEvent = (id = 4): RuntimeLedgerEvent => runtimeEvent(id, completedEventSpec());

const sessionLinkEvent = (id = 5): RuntimeLedgerEvent =>
  runtimeEvent(
    id,
    agentSessionTurnSubmittedEvent({
      ...identity,
      sessionRef: "session:s1",
      turnRef: "turn:s1:1",
      runtimeRunId: 1,
      idempotencyKey: "turn:s1:1",
    }),
  );

const cancelledEvent = (id = 6): RuntimeLedgerEvent =>
  runtimeEvent(
    id,
    agentRunAbortedEvent({
      ...identity,
      kind: ABORT.DECISION_CANCELLED,
      runId: 1,
      tokensUsed: 1,
      payload: { reason: "operator_cancelled" },
    }),
  );

describe("@agent-os/client", () => {
  it("owns a framework-neutral subscribe/getSnapshot store contract", () => {
    const store = createAgentClientStore({ count: 0 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.setSnapshot({ count: 1 });
    unsubscribe();
    store.setSnapshot({ count: 2 });

    expect(notifications).toBe(1);
    expect(store.getSnapshot()).toEqual({ count: 2 });
    expect(selectAgentClientSnapshot(store, (snapshot) => snapshot.count)).toBe(2);
  });

  it("keeps canonical runtime events as the client read-model without UI projection", () => {
    const events = [startedEvent(), interruptedEvent()];
    const client = createAgentClient({ initialEvents: events });
    const snapshot = client.getSnapshot();

    expect(snapshot.events).toEqual(events);
    expect(snapshot.events[0]).toBe(events[0]);
    expect(snapshot.events[1]).toBe(events[1]);
    expect(snapshot.lastEventId).toBe(2);
    expect(snapshot.run.status).toBe("interrupted");
  });

  it("derives and consumes Recorded continuation and input request refs from runtime events", () => {
    const client = createAgentClient();
    client.appendEvents([startedEvent(), interruptedEvent()]);

    const interrupted = client.getSnapshot();
    const continuationRef = interrupted.run.activeContinuationRef;
    const inputRequest = interrupted.run.inputRequests[0];
    if (continuationRef === undefined || inputRequest === undefined) {
      expect.fail("expected Recorded refs from interruption");
    }

    expect(continuationRef.kind).toBe("agent.run.continuation");
    expect(inputRequest.ref.kind).toBe("agent.run.input_request");
    expect(isCurrentContinuationRef(interrupted, continuationRef)).toBe(true);
    expect(isCurrentInputRequestRef(interrupted, inputRequest.ref)).toBe(true);

    client.appendEvents([resumedEvent()]);
    const resumed = client.getSnapshot();

    expect(resumed.run.status).toBe("running");
    expect(resumed.run.activeContinuationRef).toBeUndefined();
    expect(isCurrentContinuationRef(resumed, continuationRef)).toBe(false);
    expect(isCurrentInputRequestRef(resumed, inputRequest.ref)).toBe(false);
    expect(resumed.run.inputRequests[0]?.status).toBe("resumed");
    expect(resumed.run.inputRequests[0]?.resumedAtEventId).toBe(3);
  });

  it("projects long-running run inspection from the replay snapshot", () => {
    const client = createAgentClient({
      initialEvents: [startedEvent(), sessionLinkEvent(), interruptedEvent()],
    });
    const interrupted = projectAgentClientRunInspection(client.getSnapshot());

    expect(interrupted).toMatchObject({
      runId: 1,
      status: "interrupted",
      lastKnownEvent: { id: 5, ts: 50, kind: "agent_session.turn_submitted" },
      request: {
        kind: "waiting_for_input",
        interruptId: "interrupt-1",
        reason: "approval_required",
        at: 20,
      },
      cancellation: { kind: "none" },
      productLink: {
        kind: "session_turn",
        eventId: 5,
        submittedAt: 50,
        sessionRef: "session:s1",
        turnRef: "turn:s1:1",
      },
    });

    client.appendEvents([cancelledEvent()]);
    expect(projectAgentClientRunInspection(client.getSnapshot())).toMatchObject({
      status: "aborted",
      cancellation: {
        kind: "cancelled",
        at: 60,
        event: "agent.aborted.cancelled",
        reason: "operator_cancelled",
      },
    });
  });

  it("deduplicates replayed events and reconnects from the last runtime event id", async () => {
    const cursors: Array<number | undefined> = [];
    const source: AgentClientStreamSource = {
      open(cursor) {
        cursors.push(cursor.afterEventId);
        return (async function* () {
          yield interruptedEvent();
          yield interruptedEvent();
          yield completedEvent();
        })();
      },
    };
    const client = createAgentClient({ initialEvents: [startedEvent()], streamSource: source });

    await client.connect();

    expect(cursors).toEqual([1]);
    expect(client.getSnapshot().events.map((event) => event.id)).toEqual([1, 2, 4]);
    expect(client.getSnapshot().connection.status).toBe("closed");
    expect(client.getSnapshot().run.status).toBe("completed");
  });

  it("decodes LedgerEventRpc stream frames before appending runtime events", async () => {
    const cursors: Array<number | undefined> = [];
    const source = createAgentClientRuntimeLedgerStreamSource({
      open(cursor) {
        cursors.push(cursor.afterEventId);
        return (async function* () {
          yield runtimeLedgerRpc(2, interruptedEventSpec());
          yield runtimeLedgerRpc(4, completedEventSpec());
        })();
      },
    });
    const client = createAgentClient({ initialEvents: [startedEvent()], streamSource: source });

    await client.connect();

    expect(cursors).toEqual([1]);
    expect(client.getSnapshot().events.map((event) => event.id)).toEqual([1, 2, 4]);
    expect(client.getSnapshot().run.status).toBe("completed");
  });

  it("decodes runtime ledger SSE data through the same positive runtime contract", async () => {
    const decoded = decodeAgentClientRuntimeLedgerSseEvent({
      data: JSON.stringify(runtimeLedgerRpc(1, startedEventSpec())),
    });
    expect(decoded).toMatchObject({ ok: true, event: { kind: "agent.run.started", id: 1 } });

    const source = createAgentClientRuntimeLedgerSseStreamSource({
      open() {
        return (async function* () {
          yield { data: JSON.stringify(runtimeLedgerRpc(1, startedEventSpec())) };
          yield { data: JSON.stringify(runtimeLedgerRpc(4, completedEventSpec())) };
        })();
      },
    });
    const client = createAgentClient({ streamSource: source });

    await client.connect();

    expect(client.getSnapshot().events.map((event) => event.kind)).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  it("rejects product UI and non-runtime ledger events at the client wire boundary", () => {
    expect(
      decodeAgentClientRuntimeLedgerEvent({
        seq: 1,
        runId: "CH-42-run-001",
        kind: "workbench.candidate.ready",
        title: "候选已准备",
      }),
    ).toMatchObject({
      ok: false,
      failure: { reason: "ledger_event_malformed" },
    });

    expect(
      decodeAgentClientRuntimeLedgerEvent({
        id: 99,
        ts: 990,
        kind: "workbench.candidate.ready",
        scopeRef: identity.scopeRef,
        factOwnerRef: "zeroY3",
        effectAuthorityRef: identity.effectAuthorityRef,
        payload: { candidateRef: "candidate:CH-42:run-001:1" },
      } satisfies LedgerEvent),
    ).toMatchObject({
      ok: false,
      failure: { reason: "non_runtime_event" },
    });

    expect(decodeAgentClientRuntimeLedgerSseEvent({ data: "{not json" })).toMatchObject({
      ok: false,
      failure: { reason: "sse_data_invalid_json" },
    });
  });

  it("fails a runtime stream when a runtime event payload does not decode", async () => {
    const source = createAgentClientRuntimeLedgerStreamSource({
      open() {
        return (async function* () {
          yield {
            ...runtimeLedgerRpc(4, completedEventSpec()),
            payload: { final: "missing required runId" },
          };
        })();
      },
    });
    const client = createAgentClient({ streamSource: source });

    await client.connect();

    expect(client.getSnapshot().connection).toMatchObject({
      status: "failed",
      error: "runtime ledger event payload failed runtime-protocol decode",
    });
    expect(client.getSnapshot().events).toEqual([]);
  });

  it("consumes an already-aborted AbortSignal before opening a stream", async () => {
    let opened = false;
    const source: AgentClientStreamSource = {
      open() {
        opened = true;
        return (async function* () {})();
      },
    };
    const abort = new AbortController();
    abort.abort();
    const client = createAgentClient({ streamSource: source });

    await client.connect({ signal: abort.signal });

    expect(opened).toBe(false);
    expect(client.getSnapshot().connection.status).toBe("closed");
  });

  it("keeps commands behind a generic rpcInvoker instead of hard-coded methods", async () => {
    type Commands = {
      readonly submit: AgentClientCommandSpec<
        { readonly intent: string },
        { readonly runId: number }
      >;
      readonly readFile: AgentClientCommandSpec<
        { readonly path: string },
        { readonly text: string }
      >;
    };
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const client = createAgentClient<Commands>({
      rpcInvoker: async (name, input) => {
        calls.push({ name, input });
        if (name === "submit") return { runId: 1 };
        return { text: "hello" };
      },
    });

    await expect(client.invoke("submit", { intent: "ship" })).resolves.toEqual({ runId: 1 });
    await expect(client.invoke("readFile", { path: "/workspace/a.txt" })).resolves.toEqual({
      text: "hello",
    });
    expect(calls).toEqual([
      { name: "submit", input: { intent: "ship" } },
      { name: "readFile", input: { path: "/workspace/a.txt" } },
    ]);
  });

  it("can apply runtime event replay without a transport", () => {
    const snapshot = appendRuntimeEventsToSnapshot(createAgentClient().getSnapshot(), [
      startedEvent(),
      completedEvent(),
    ]);

    expect(snapshot.connection.status).toBe("idle");
    expect(snapshot.run.status).toBe("completed");
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "agent.run.started",
      "agent.run.completed",
    ]);
  });

  it("routes session and workflow product methods through generated RPC command names", async () => {
    interface ProductProjections extends WorkspaceAgentProductProjectionTypes {
      readonly session: { readonly sessionRef: string };
      readonly sessionList: { readonly sessions: ReadonlyArray<{ readonly sessionRef: string }> };
      readonly workflowRun: { readonly workflowRunId: string };
      readonly workflowRunList: {
        readonly runs: ReadonlyArray<{ readonly workflowRunId: string }>;
      };
    }
    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const bridge = createWorkspaceAgentClientBridge<ProductProjections>({
      rpcInvoker: async (name, input) => {
        calls.push({ name, input });
        if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION) {
          return { sessionRef: "support:42" };
        }
        if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS) {
          return { sessions: [{ sessionRef: "support:42" }] };
        }
        if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN) {
          return { workflowRunId: "workflow-run:report:1" };
        }
        if (name === WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS) {
          return { runs: [{ workflowRunId: "workflow-run:report:1" }] };
        }
        return { status: "accepted", runId: 1, submittedAtEventId: 1 };
      },
    });

    await bridge.sessions.submitTurn({
      sessionRef: "support:42",
      turnRef: "turn:support:42:1",
      intent: "reply to support",
      context: {},
    });
    await expect(bridge.sessions.inspect("support:42")).resolves.toEqual({
      sessionRef: "support:42",
    });
    await expect(bridge.sessions.list()).resolves.toEqual({
      sessions: [{ sessionRef: "support:42" }],
    });
    await bridge.workflows.run({
      workflowId: "report",
      workflowRunId: "workflow-run:report:1",
      intent: "write report",
      context: {},
    });
    await expect(bridge.workflows.inspectRun("report", "workflow-run:report:1")).resolves.toEqual({
      workflowRunId: "workflow-run:report:1",
    });
    await expect(bridge.workflows.listRuns("report")).resolves.toEqual({
      runs: [{ workflowRunId: "workflow-run:report:1" }],
    });

    expect(calls).toEqual([
      {
        name: WORKSPACE_AGENT_PRODUCT_COMMAND.SUBMIT_SESSION_TURN,
        input: {
          sessionRef: "support:42",
          turnRef: "turn:support:42:1",
          intent: "reply to support",
          context: {},
        },
      },
      {
        name: WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_SESSION,
        input: { sessionRef: "support:42" },
      },
      { name: WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_SESSIONS, input: {} },
      {
        name: WORKSPACE_AGENT_PRODUCT_COMMAND.RUN_WORKFLOW,
        input: {
          workflowId: "report",
          workflowRunId: "workflow-run:report:1",
          intent: "write report",
          context: {},
        },
      },
      {
        name: WORKSPACE_AGENT_PRODUCT_COMMAND.INSPECT_WORKFLOW_RUN,
        input: { workflowId: "report", workflowRunId: "workflow-run:report:1" },
      },
      {
        name: WORKSPACE_AGENT_PRODUCT_COMMAND.LIST_WORKFLOW_RUNS,
        input: { workflowId: "report" },
      },
    ]);
  });

  it("routes input-request settlement inspection through the runtime command surface", async () => {
    const snapshot = createAgentClient({
      initialEvents: [startedEvent(), interruptedEvent()],
    }).getSnapshot();
    const ref = snapshot.run.inputRequests[0]?.ref;
    if (ref === undefined) expect.fail("expected pending input request ref");

    const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const bridge = createWorkspaceAgentClientBridge({
      rpcInvoker: async (name, input) => {
        calls.push({ name, input });
        return {
          status: "pending",
          ref,
          request: {
            ref,
            kind: "approval",
            subjectRef: "subject-1",
            toolCallId: "tool-call-1",
            toolName: "write_file",
            resumeSchema: { type: "object" },
          },
        };
      },
    });

    await expect(bridge.inspectInputRequest({ ref })).resolves.toMatchObject({
      status: "pending",
      ref,
      request: { subjectRef: "subject-1" },
    });
    expect(calls).toEqual([
      {
        name: WORKSPACE_AGENT_COMMAND.INSPECT_INPUT_REQUEST,
        input: { ref },
      },
    ]);
  });
});
