import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim } from "@agent-os/kernel/effect-claim";
import { canonicalTelemetryEventTreeJson } from "@agent-os/telemetry-protocol";
import { projectTelemetryEventTree } from "../src/telemetry-tree";
import {
  agentRunCompletedEvent,
  agentRunStartedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";

const scope = "telemetry-tree";
const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};
const traceContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
};

const livedClaim: LivedClaim = {
  phase: "lived",
  operationRef: "tool:telemetry-tree:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  anchorRef: {
    anchorId: "tool.executed:tool:telemetry-tree:1:0:call-1",
    anchorKind: "carrier_proof",
    carrierRef: "tool:lookup",
  },
};

const event = (id: number, spec: RuntimeEventCommitSpec, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind: spec.kind,
  scopeRef: spec.scopeRef,
  effectAuthorityRef: spec.effectAuthorityRef,
  factOwnerRef: "@agent-os/test",
  payload: spec.payload,
});

const rawEvent = (id: number, kind: string, payload: unknown, ts = id * 10): LedgerEvent => ({
  id,
  ts,
  kind,
  scopeRef: { kind: "conversation", scopeId: scope },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
  payload,
});

const fixtureEvents = (timeOffset: number): ReadonlyArray<LedgerEvent> => [
  event(
    1,
    agentRunStartedEvent({ ...runtimeIdentity, intent: "redacted intent", traceContext }),
    100 + timeOffset,
  ),
  event(
    2,
    llmResponseEvent({
      ...runtimeIdentity,
      turn: { id: 1, index: 0 },
      items: [{ type: "message", text: "redacted completion" }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      traceContext,
    }),
    120 + timeOffset,
  ),
  event(
    3,
    toolExecutedEvent({
      ...runtimeIdentity,
      runId: 1,
      toolCallId: "call-1",
      name: "lookup",
      args: '{"secret":"value"}',
      execution: {
        kind: "external",
        access: "read",
        domain: { kind: "workspace", ref: "local" },
      },
      result: { ok: true },
      claim: livedClaim,
      traceContext,
    }),
    130 + timeOffset,
  ),
  rawEvent(4, "dispatch.outbound.delivered", { traceContext }, 140 + timeOffset),
  event(
    5,
    agentRunCompletedEvent({
      ...runtimeIdentity,
      runId: 1,
      final: "done",
      output: "done",
      outputKind: "text",
      tokensUsed: 15,
      traceContext,
    }),
    150 + timeOffset,
  ),
];

describe("runtime telemetry tree projection", () => {
  it.effect("projects ledger facts into a backend-neutral canonical telemetry tree", () =>
    Effect.gen(function* () {
      const cfTree = yield* projectTelemetryEventTree(fixtureEvents(0));
      const pgTree = yield* projectTelemetryEventTree(fixtureEvents(1000));

      expect(cfTree.nodes.map((node) => node.name)).toEqual([
        "agent.run",
        "gen_ai.call",
        "tool.execute",
        "dispatch.delivery",
      ]);
      expect(cfTree.nodes.map((node) => node.telemetryKind)).toEqual([
        "agent_run",
        "llm_call",
        "tool_execution",
        "dispatch_delivery",
      ]);
      expect(cfTree.nodes.map((node) => node.outcome)).toEqual(["ok", "ok", "ok", "ok"]);
      expect(cfTree.nodes.map((node) => node.emitKind)).toEqual([
        "runtime",
        "provider",
        "runtime",
        "backend",
      ]);
      expect(canonicalTelemetryEventTreeJson(cfTree)).toBe(canonicalTelemetryEventTreeJson(pgTree));
    }),
  );

  it.effect("fails closed on malformed trace context in source events", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        projectTelemetryEventTree([
          rawEvent(1, "dispatch.outbound.delivered", {
            traceContext: { traceparent: "00-test" },
          }),
        ]),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
