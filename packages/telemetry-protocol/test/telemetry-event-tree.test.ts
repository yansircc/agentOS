import { describe, expect, it } from "@effect/vitest";

import {
  canonicalTelemetryEventTreeJson,
  canonicalizeTelemetryEventTree,
  telemetryEventTreesEqual,
  type TelemetryEventTree,
} from "../src/index";

const traceContext = {
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
};

describe("telemetry event tree", () => {
  it("canonicalizes timing, generated ids, and backend host ids while preserving semantics", () => {
    const left: TelemetryEventTree = {
      nodes: [
        {
          id: "cf-span-9",
          telemetryKind: "dispatch_delivery",
          emitKind: "backend",
          name: "dispatch.delivery",
          at: 100,
          endedAt: 101,
          outcome: "ok",
          ledgerEventId: 12,
          sourceEventIds: [12],
          traceContext,
          attributes: {
            "agentos.backend.host_id": "cf-do:abc",
            "agentos.event.kind": "dispatch.outbound.delivered",
            "agentos.generated.span_id": "cf-generated",
          },
        },
        {
          id: "cf-root",
          telemetryKind: "agent_run",
          emitKind: "runtime",
          name: "agent.run",
          at: 90,
          endedAt: 130,
          outcome: "ok",
          ledgerEventId: 10,
          sourceEventIds: [10, 13],
          traceContext,
          attributes: {
            "agentos.run.id": 10,
            "agentos.duration_ms": 1200,
          },
        },
      ],
    };
    const right: TelemetryEventTree = {
      nodes: [
        {
          id: "pg-root",
          telemetryKind: "agent_run",
          emitKind: "runtime",
          name: "agent.run",
          at: 900,
          endedAt: 930,
          outcome: "ok",
          ledgerEventId: 10,
          sourceEventIds: [13, 10],
          traceContext,
          attributes: {
            "agentos.duration_ms": 5,
            "agentos.run.id": 10,
          },
        },
        {
          id: "pg-span-1",
          telemetryKind: "dispatch_delivery",
          emitKind: "backend",
          name: "dispatch.delivery",
          at: 940,
          endedAt: 945,
          outcome: "ok",
          ledgerEventId: 12,
          sourceEventIds: [12],
          traceContext,
          attributes: {
            "agentos.backend.host_id": "postgres-worker:7",
            "agentos.event.kind": "dispatch.outbound.delivered",
            "agentos.generated.span_id": "pg-generated",
          },
        },
      ],
    };

    expect(telemetryEventTreesEqual(left, right)).toBe(true);
    expect(canonicalizeTelemetryEventTree(left)).toEqual(canonicalizeTelemetryEventTree(right));
  });

  it("preserves semantic attributes and topology in the canonical tree", () => {
    const base: TelemetryEventTree = {
      nodes: [
        {
          id: "root-a",
          telemetryKind: "agent_run",
          emitKind: "runtime",
          name: "agent.run",
          outcome: "ok",
          ledgerEventId: 1,
          attributes: { "agentos.run.id": 1 },
        },
        {
          id: "child-a",
          parentId: "root-a",
          telemetryKind: "llm_call",
          emitKind: "provider",
          name: "gen_ai.call",
          outcome: "ok",
          ledgerEventId: 2,
          attributes: { "gen_ai.usage.output_tokens": 5 },
        },
      ],
    };
    const changed: TelemetryEventTree = {
      nodes: [
        {
          id: "root-b",
          telemetryKind: "agent_run",
          emitKind: "runtime",
          name: "agent.run",
          outcome: "ok",
          ledgerEventId: 1,
          attributes: { "agentos.run.id": 1 },
        },
        {
          id: "child-b",
          parentId: "root-b",
          telemetryKind: "llm_call",
          emitKind: "provider",
          name: "gen_ai.call",
          outcome: "ok",
          ledgerEventId: 2,
          attributes: { "gen_ai.usage.output_tokens": 6 },
        },
      ],
    };

    expect(telemetryEventTreesEqual(base, changed)).toBe(false);
    expect(canonicalTelemetryEventTreeJson(base)).toContain('"parentId":"telemetry-node:1"');
  });
});
