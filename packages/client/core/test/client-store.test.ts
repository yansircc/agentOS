import { describe, expect, it } from "vite-plus/test";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunResumedEvent,
  agentRunStartedEvent,
  decodeRuntimeLedgerEvent,
  RUNTIME_FACT_OWNER,
  type RuntimeEventCommitSpec,
  type RuntimeLedgerEvent,
} from "@agent-os/runtime-protocol";
import {
  appendRuntimeEventsToSnapshot,
  createAgentClient,
  createAgentClientStore,
  isCurrentContinuationRef,
  isCurrentInputRequestRef,
  selectAgentClientSnapshot,
  type AgentClientCommandSpec,
  type AgentClientStreamSource,
} from "../src/index";

const identity = {
  scopeRef: { kind: "session" as const, scopeId: "client-test" },
  effectAuthorityRef: { authorityClass: "test", authorityId: "client-test" },
};

const runtimeEvent = (id: number, spec: RuntimeEventCommitSpec): RuntimeLedgerEvent => {
  const decoded = decodeRuntimeLedgerEvent({
    id,
    ts: id * 10,
    kind: spec.kind,
    scopeRef: spec.scopeRef,
    factOwnerRef: RUNTIME_FACT_OWNER,
    effectAuthorityRef: spec.effectAuthorityRef,
    payload: spec.payload,
  } satisfies LedgerEvent);
  if (decoded._tag !== "runtime") expect.fail("expected runtime event");
  return decoded.event;
};

const startedEvent = (id = 1): RuntimeLedgerEvent =>
  runtimeEvent(id, agentRunStartedEvent({ ...identity, intent: "test" }));

const interruptedEvent = (id = 2): RuntimeLedgerEvent =>
  runtimeEvent(
    id,
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
    }),
  );

const resumedEvent = (id = 3): RuntimeLedgerEvent =>
  runtimeEvent(
    id,
    agentRunResumedEvent({
      ...identity,
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "interrupt-1",
      resume: { kind: "approval", approved: true },
      resumedAtEventId: 4,
    }),
  );

const completedEvent = (id = 4): RuntimeLedgerEvent =>
  runtimeEvent(
    id,
    agentRunCompletedEvent({
      ...identity,
      runId: 1,
      final: "done",
      output: "done",
      outputKind: "text",
      tokensUsed: 11,
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
});
