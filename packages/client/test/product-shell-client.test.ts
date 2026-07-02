import { describe, expect, it } from "vite-plus/test";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  agentRunCompletedEvent,
  agentRunInterruptedEvent,
  agentRunStartedEvent,
  decodeRuntimeLedgerEvent,
  RUNTIME_FACT_OWNER,
  type RuntimeEventCommitSpec,
  type RuntimeLedgerEvent,
} from "@agent-os/core/runtime-protocol";
import type { AgentClientCommandSpec, AgentClientStreamSource } from "../src/index";
import { projectAgentClientRunInspection } from "../src/index";
import { createProductShellAgentClient } from "../src/product-shell-client";

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
