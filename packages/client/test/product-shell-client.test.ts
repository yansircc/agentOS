import { describe, expect, it, vi } from "vite-plus/test";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunStartedEvent,
  decodeRuntimeLedgerEvent,
  RUNTIME_FACT_OWNER,
  type RuntimeEventCommitSpec,
  type RuntimeLedgerEvent,
  type SubmitResult,
} from "@agent-os/core/runtime-protocol";
import type { AgentClientCommandSpec, AgentClientStreamSource } from "../src/index";
import { projectAgentClientRunInspection } from "../src/index";
import { createAgentSession, createProductShellAgentClient } from "../src/product-shell-client";

const identity = {
  scopeRef: { kind: "session" as const, scopeId: "product-shell-client-pattern" },
  effectAuthorityRef: { authorityClass: "test", authorityId: "product-shell" },
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

const startedEvent = (): RuntimeLedgerEvent =>
  runtimeEvent(1, agentRunStartedEvent({ ...identity, intent: "prepare product candidate" }));

const interruptedEvent = (): RuntimeLedgerEvent =>
  runtimeEvent(
    2,
    agentRunInterruptedEvent({
      ...identity,
      runId: 1,
      turn: { id: 1, index: 0 },
      interruptId: "approval:1",
      reason: "approval_required",
      resumeSchema: { type: "object" },
      tokensUsed: 11,
      decision: {
        gateRef: "gate:publish:1",
        subjectRef: "candidate:opaque:1",
        toolCallId: "tool-call:publish",
        toolName: "publish",
      },
    }),
  );

const completedEvent = (): RuntimeLedgerEvent =>
  runtimeEvent(
    3,
    agentRunCompletedEvent({
      ...identity,
      runId: 1,
      final: "done",
      output: "done",
      outputKind: "text",
      tokensUsed: 12,
    }),
  );

describe("@agent-os/client/product-shell-client", () => {
  it("owns default session and turn correlation through crypto.randomUUID", async () => {
    const refs = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ] as const;
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce(refs[0])
      .mockReturnValueOnce(refs[1]);
    const inputs: unknown[] = [];
    const result = {
      ok: true,
      status: "delivered",
      runId: 1,
      final: "done",
      eventCount: 2,
      tokensUsed: 3,
    } satisfies SubmitResult;
    const session = createAgentSession({
      submitTurn: async (input) => {
        inputs.push(input);
        return result;
      },
    });

    expect(session.sessionRef).toBe(refs[0]);
    await expect(session.prompt("prepare candidate")).resolves.toBe(result);
    expect(inputs).toEqual([
      {
        sessionRef: refs[0],
        turnRef: refs[1],
        intent: "prepare candidate",
        context: {},
      },
    ]);
    expect(randomUUID).toHaveBeenCalledTimes(2);
    randomUUID.mockRestore();
  });

  it("allocates monotonic turn correlation synchronously across concurrent prompts", async () => {
    const inputs: Array<{
      readonly sessionRef: string;
      readonly turnRef: string;
      readonly intent: string;
      readonly context: Record<string, unknown>;
    }> = [];
    const pending: Array<(result: SubmitResult) => void> = [];
    const turnIndexes: number[] = [];
    let sessionAllocations = 0;
    const session = createAgentSession({
      correlation: {
        createSessionRef: () => {
          sessionAllocations += 1;
          return "session:stable";
        },
        createTurnRef: ({ sessionRef, turnIndex }) => {
          turnIndexes.push(turnIndex);
          return `turn:${sessionRef}:${turnIndex}`;
        },
      },
      submitTurn: (input) => {
        inputs.push(input);
        return new Promise((resolve) => pending.push(resolve));
      },
    });

    const first = session.prompt("first prompt", {
      context: { candidateRef: "candidate:1" },
      system: "product-owned instruction",
    });
    const second = session.prompt("second prompt", {
      context: { candidateRef: "candidate:2" },
    });

    expect(sessionAllocations).toBe(1);
    expect(turnIndexes).toEqual([1, 2]);
    expect(inputs).toEqual([
      {
        sessionRef: "session:stable",
        turnRef: "turn:session:stable:1",
        intent: "first prompt",
        context: { candidateRef: "candidate:1" },
        system: "product-owned instruction",
      },
      {
        sessionRef: "session:stable",
        turnRef: "turn:session:stable:2",
        intent: "second prompt",
        context: { candidateRef: "candidate:2" },
      },
    ]);

    const firstResult = {
      ok: true,
      status: "delivered",
      runId: 1,
      final: "first",
      eventCount: 1,
      tokensUsed: 1,
    } satisfies SubmitResult;
    const secondResult = {
      ok: true,
      status: "delivered",
      runId: 2,
      final: "second",
      eventCount: 1,
      tokensUsed: 1,
    } satisfies SubmitResult;
    pending[1]?.(secondResult);
    pending[0]?.(firstResult);

    await expect(first).resolves.toBe(firstResult);
    await expect(second).resolves.toBe(secondResult);
  });

  it("composes product-owned commands with agentOS runtime ledger projection", async () => {
    type ProductCommands = {
      readonly approveCandidate: AgentClientCommandSpec<
        { readonly candidateRef: string },
        { readonly decisionRef: string; readonly receiptOutcome: "applied" }
      >;
    };
    const commandCalls: Array<{ readonly name: string; readonly input: unknown }> = [];
    const streamCursors: Array<number | undefined> = [];
    const streamSource: AgentClientStreamSource = {
      open(cursor) {
        streamCursors.push(cursor.afterEventId);
        return (async function* () {
          yield completedEvent();
        })();
      },
    };
    const client = createProductShellAgentClient<ProductCommands>({
      runtimeLedger: {
        initialEvents: [startedEvent(), interruptedEvent()],
        streamSource,
      },
      productCommands: {
        invoke: async (name, input) => {
          commandCalls.push({ name, input });
          return {
            decisionRef: "decision:product:1",
            receiptOutcome: "applied",
          };
        },
      },
    });

    expect(projectAgentClientRunInspection(client.getSnapshot())).toMatchObject({
      runId: 1,
      status: "interrupted",
      request: {
        kind: "waiting_for_input",
        interruptId: "approval:1",
        reason: "approval_required",
      },
    });

    await expect(
      client.invoke("approveCandidate", { candidateRef: "candidate:opaque:1" }),
    ).resolves.toEqual({
      decisionRef: "decision:product:1",
      receiptOutcome: "applied",
    });
    await client.connect();

    expect(commandCalls).toEqual([
      {
        name: "approveCandidate",
        input: { candidateRef: "candidate:opaque:1" },
      },
    ]);
    expect(streamCursors).toEqual([2]);
    expect(projectAgentClientRunInspection(client.getSnapshot())).toMatchObject({
      runId: 1,
      status: "completed",
      lastKnownEvent: { id: 3, kind: "agent.run.completed" },
      request: { kind: "none" },
    });
    expect(client.getSnapshot().events.map((event) => event.kind)).toEqual([
      "agent.run.started",
      "agent.run.interrupted",
      "agent.run.completed",
    ]);
  });
});
