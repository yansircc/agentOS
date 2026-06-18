import { describe, expect, it } from "@effect/vitest";
import type { LedgerEvent } from "@agent-os/kernel/types";
import type { LivedClaim } from "@agent-os/kernel/effect-claim";
import { ABORT } from "@agent-os/kernel/abort";
import { Effect } from "effect";
import { projectTelemetryEventTree } from "@agent-os/runtime";
import { OTLP_GENAI_SEMCONV_MAPPING_VERSION, projectOtlpSpans } from "../src";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  type RuntimeEventCommitSpec,
} from "@agent-os/runtime-protocol";

const scope = "otlp-projection";
const runtimeIdentity = {
  scopeRef: { kind: "conversation" as const, scopeId: scope },
  effectAuthorityRef: { authorityClass: "test", authorityId: scope },
};
const eventIdentity = (scopeId: string) => ({
  scopeRef: { kind: "conversation" as const, scopeId },
  factOwnerRef: "@agent-os/test",
  effectAuthorityRef: { authorityClass: "test", authorityId: scopeId },
});
const traceContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  tracestate: "vendor=value",
};

const livedClaim: LivedClaim = {
  phase: "lived",
  operationRef: "tool:otlp-projection:1:0:call-1",
  scopeRef: { kind: "conversation", scopeId: scope },
  effectAuthorityRef: { authorityId: "tool:lookup", authorityClass: "read" },
  originRef: { originId: "run:1", originKind: "submit" },
  anchorRef: {
    anchorId: "tool.executed:tool:otlp-projection:1:0:call-1",
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
  ...eventIdentity(scope),
  payload,
});

const projectOtlpFromEvents = (events: ReadonlyArray<LedgerEvent>) =>
  Effect.map(projectTelemetryEventTree(events), projectOtlpSpans);

const spanJson = (events: ReadonlyArray<LedgerEvent>) =>
  Effect.map(projectOtlpFromEvents(events), (projection) => JSON.stringify(projection.spans));

describe("OTLP trace projection", () => {
  it.effect("maps runtime telemetry tree nodes to ordered OTLP spans", () =>
    Effect.gen(function* () {
      const projection = yield* projectOtlpFromEvents([
        event(
          1,
          agentRunStartedEvent({ ...runtimeIdentity, intent: "secret prompt", traceContext }),
          100,
        ),
        event(
          2,
          chatIngestedEvent({
            ...runtimeIdentity,
            runId: 1,
            intent: "secret prompt",
            context: { credential: "sk-secret" },
            traceContext,
          }),
          110,
        ),
        event(
          3,
          llmResponseEvent({
            ...runtimeIdentity,
            turn: { id: 1, index: 0 },
            items: [{ type: "message", text: "secret completion" }],
            usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            traceContext,
          }),
          120,
        ),
        event(
          4,
          toolExecutedEvent({
            ...runtimeIdentity,
            runId: 1,
            toolCallId: "call-1",
            name: "lookup",
            args: '{"credential":"sk-secret"}',
            execution: {
              kind: "external",
              access: "read",
              domain: { kind: "workspace", ref: "local" },
            },
            result: { fileBytes: "secret bytes", ok: true },
            claim: livedClaim,
            traceContext,
          }),
          130,
        ),
        rawEvent(
          5,
          "dispatch.outbound.delivered",
          {
            target: "hidden target",
            providerUrl: "https://provider.example/private",
            traceContext,
          },
          140,
        ),
        event(
          6,
          agentRunCompletedEvent({
            ...runtimeIdentity,
            runId: 1,
            final: "done",
            output: "done",
            outputKind: "text",
            tokensUsed: 15,
            traceContext,
          }),
          150,
        ),
      ]);

      expect(projection.mappingVersion).toBe(OTLP_GENAI_SEMCONV_MAPPING_VERSION);
      expect(projection.spans.map((span) => span.kind)).toEqual([
        "agent_run",
        "llm_call",
        "tool_execution",
        "dispatch_delivery",
      ]);
      expect(projection.spans.map((span) => span.sourceEventIds[0])).toEqual([1, 3, 4, 5]);
      expect(projection.spans[0]).toMatchObject({
        name: "agent.run",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        status: "OK",
        sourceEventIds: [1, 6],
      });
      expect(projection.spans[1]?.parentSpanId).toBe(projection.spans[0]?.spanId);
      expect(projection.spans[2]?.parentSpanId).toBe(projection.spans[0]?.spanId);
      expect(projection.spans[2]?.attributes).toMatchObject({
        "agentos.tool.name": "lookup",
        "agentos.execution_domain.kind": "workspace",
        "agentos.execution_domain.ref": "local",
      });
    }),
  );

  it.effect("redacts content and sensitive provider/material data by default", () =>
    Effect.gen(function* () {
      const json = yield* spanJson([
        event(
          1,
          agentRunStartedEvent({ ...runtimeIdentity, intent: "secret prompt", traceContext }),
        ),
        event(
          2,
          chatIngestedEvent({
            ...runtimeIdentity,
            runId: 1,
            intent: "secret prompt",
            context: { credential: "sk-secret" },
            traceContext,
          }),
        ),
        event(
          3,
          llmResponseEvent({
            ...runtimeIdentity,
            turn: { id: 1, index: 0 },
            items: [{ type: "message", text: "secret completion" }],
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            traceContext,
          }),
        ),
        event(
          4,
          toolExecutedEvent({
            ...runtimeIdentity,
            runId: 1,
            toolCallId: "call-1",
            name: "lookup",
            args: '{"credential":"sk-secret"}',
            execution: { kind: "deterministic" },
            result: { fileBytes: "secret bytes" },
            claim: livedClaim,
            traceContext,
          }),
        ),
        rawEvent(5, "dispatch.outbound.delivered", {
          traceContext,
          providerUrl: "https://provider.example/private",
        }),
        event(
          6,
          agentRunAbortedEvent({
            ...runtimeIdentity,
            kind: ABORT.TOOL_ERROR,
            runId: 1,
            tokensUsed: 2,
            payload: { cause: "secret error detail" },
            traceContext,
          }),
        ),
      ]);

      expect(json).not.toContain("secret prompt");
      expect(json).not.toContain("secret completion");
      expect(json).not.toContain("sk-secret");
      expect(json).not.toContain("secret bytes");
      expect(json).not.toContain("provider.example");
      expect(json).not.toContain("secret error detail");
    }),
  );

  it.effect("fails closed before the OTLP adapter boundary on malformed source trace context", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        projectTelemetryEventTree([
          rawEvent(1, "dispatch.outbound.delivered", {
            traceContext: { traceparent: "00-test" },
          }),
        ]),
      );
      expect(result._tag).toBe("Left");
    }),
  );

  it("maps telemetry trees without reading ledger payloads", () => {
    const projection = projectOtlpSpans({
      nodes: [
        {
          id: "custom-node",
          telemetryKind: "dispatch_delivery",
          emitKind: "backend",
          name: "dispatch.delivery",
          at: 1,
          endedAt: 2,
          outcome: "ok",
          ledgerEventId: 9,
          sourceEventIds: [9],
          attributes: {
            "agentos.event.kind": "dispatch.outbound.delivered",
          },
        },
      ],
    });

    expect(projection.spans).toHaveLength(1);
    expect(projection.spans[0]).toMatchObject({
      kind: "dispatch_delivery",
      status: "OK",
      startTimeUnixNano: 1_000_000,
      endTimeUnixNano: 2_000_000,
    });
  });

  it("projects extension telemetry kinds from the protocol tree", () => {
    const projection = projectOtlpSpans({
      nodes: [
        {
          id: "extension-node",
          telemetryKind: "product.custom_step",
          emitKind: "carrier",
          name: "product.custom_step",
          at: 7,
          endedAt: 11,
          outcome: "unset",
          sourceEventIds: [42],
          attributes: {
            "agentos.extension.owner": "@agent-os/product",
          },
        },
      ],
    });

    expect(projection.spans).toEqual([
      {
        name: "product.custom_step",
        kind: "product.custom_step",
        spanId: "3f6da73a28bd1d3d",
        startTimeUnixNano: 7_000_000,
        endTimeUnixNano: 11_000_000,
        status: "UNSET",
        attributes: {
          "agentos.mapping.version": OTLP_GENAI_SEMCONV_MAPPING_VERSION,
          "agentos.extension.owner": "@agent-os/product",
        },
        sourceEventIds: [42],
      },
    ]);
  });
});
