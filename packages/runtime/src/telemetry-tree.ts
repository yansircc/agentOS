import { authorityRefKey, factOwnerKey, scopeRefKey } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { ABORT } from "@agent-os/kernel/abort";
import {
  validateOptionalTraceContext,
  type TelemetryAttributeValue,
  type TelemetryEmitKind,
  type TelemetryEventNode,
  type TelemetryEventTree,
  type TraceContext,
} from "@agent-os/telemetry-protocol";
import {
  decodeRuntimeLedgerEvent,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type RuntimeLedgerEvent,
} from "@agent-os/runtime-protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const traceContextFromPayload = (payload: unknown): TraceContext | undefined => {
  if (!isRecord(payload)) return undefined;
  const parsed = validateOptionalTraceContext(payload.traceContext);
  if (!parsed.ok) throw new TypeError(`traceContext malformed: ${parsed.reason}`);
  return parsed.traceContext;
};

const runtimeEventsOf = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<RuntimeLedgerEvent> => {
  const runtimeEvents: RuntimeLedgerEvent[] = [];
  for (const event of events) {
    const decoded = decodeRuntimeLedgerEvent(event);
    if (decoded._tag === "runtime") runtimeEvents.push(decoded.event);
  }
  return runtimeEvents;
};

const runIdForRuntimeEvent = (event: RuntimeLedgerEvent): number => {
  switch (event.kind) {
    case RUNTIME_EVENT_KIND.AGENT_RUN_STARTED:
      return event.id;
    case RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED:
    case RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED:
    case RUNTIME_EVENT_KIND.CHAT_INGESTED:
    case RUNTIME_EVENT_KIND.TOOL_EXECUTED:
    case RUNTIME_EVENT_KIND.TOOL_REJECTED:
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
    case ABORT.BUDGET_TOKENS:
    case ABORT.BUDGET_TIME:
    case ABORT.TOOL_ERROR:
    case ABORT.UPSTREAM_FAILURE:
    case ABORT.RETRIES:
    case ABORT.CLIENT_DISCONNECT:
      return event.payload.runId;
    case RUNTIME_EVENT_KIND.LLM_RESPONSE:
      return event.payload.turn.id;
  }
};

const terminalForRun = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): RuntimeLedgerEvent | undefined =>
  runtimeEvents.find(
    (event) =>
      (event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED ||
        isRuntimeAbortEventKind(event.kind)) &&
      runIdForRuntimeEvent(event) === runId,
  );

const traceContextForRun = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  runId: number,
): TraceContext | undefined =>
  runtimeEvents.find(
    (event) =>
      event.kind === RUNTIME_EVENT_KIND.AGENT_RUN_STARTED &&
      event.id === runId &&
      event.payload.traceContext !== undefined,
  )?.payload.traceContext;

const runtimeTraceContext = (
  runtimeEvents: ReadonlyArray<RuntimeLedgerEvent>,
  event: RuntimeLedgerEvent,
): TraceContext | undefined => {
  const direct = traceContextFromPayload(event.payload);
  return direct ?? traceContextForRun(runtimeEvents, runIdForRuntimeEvent(event));
};

const telemetryNode = (spec: {
  readonly event: LedgerEvent;
  readonly emitKind: TelemetryEmitKind;
  readonly name: string;
  readonly parentId?: string;
  readonly traceContext?: TraceContext;
  readonly sourceEventIds?: ReadonlyArray<number>;
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
}): TelemetryEventNode => ({
  id: `ledger:${spec.event.id}:${spec.name}`,
  ...(spec.parentId === undefined ? {} : { parentId: spec.parentId }),
  emitKind: spec.emitKind,
  name: spec.name,
  at: spec.event.ts,
  ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  ledgerEventId: spec.event.id,
  sourceEventIds: spec.sourceEventIds ?? [spec.event.id],
  ...(spec.attributes === undefined ? {} : { attributes: spec.attributes }),
});

const runNodeId = (runId: number): string => `ledger:${runId}:agent.run`;

const runtimeTelemetryNodes = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<TelemetryEventNode> => {
  const runtimeEvents = runtimeEventsOf(events);
  const nodes: TelemetryEventNode[] = [];

  for (const start of runtimeEvents) {
    if (start.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_STARTED) continue;
    const terminal = terminalForRun(runtimeEvents, start.id);
    nodes.push(
      telemetryNode({
        event: start,
        emitKind: "runtime",
        name: "agent.run",
        traceContext: runtimeTraceContext(runtimeEvents, start),
        sourceEventIds: terminal === undefined ? [start.id] : [start.id, terminal.id],
        attributes: {
          "agentos.run.id": start.id,
          "agentos.event.kind": start.kind,
          "agentos.run.status":
            terminal === undefined
              ? "open"
              : terminal.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED
                ? "completed"
                : "failed",
        },
      }),
    );
  }

  for (const event of runtimeEvents) {
    if (event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE) {
      nodes.push(
        telemetryNode({
          event,
          parentId: runNodeId(event.payload.turn.id),
          emitKind: "provider",
          name: "gen_ai.call",
          traceContext: runtimeTraceContext(runtimeEvents, event),
          attributes: {
            "agentos.run.id": event.payload.turn.id,
            "agentos.turn.index": event.payload.turn.index,
            "agentos.event.kind": event.kind,
            "gen_ai.operation.name": "chat",
            "gen_ai.usage.input_tokens": event.payload.usage.promptTokens,
            "gen_ai.usage.output_tokens": event.payload.usage.completionTokens,
          },
        }),
      );
      continue;
    }
    if (
      event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED ||
      event.kind === RUNTIME_EVENT_KIND.TOOL_REJECTED
    ) {
      const domain =
        event.payload.execution.kind === "effectful" ? event.payload.execution.domain : undefined;
      nodes.push(
        telemetryNode({
          event,
          parentId: runNodeId(event.payload.runId),
          emitKind: "runtime",
          name: "tool.execute",
          traceContext: runtimeTraceContext(runtimeEvents, event),
          attributes: {
            "agentos.run.id": event.payload.runId,
            "agentos.tool.name": event.payload.name,
            "agentos.tool.execution.kind": event.payload.execution.kind,
            "agentos.event.kind": event.kind,
            ...(domain === undefined
              ? {}
              : {
                  "agentos.execution_domain.kind": domain.kind,
                  "agentos.execution_domain.ref": domain.ref,
                }),
          },
        }),
      );
    }
  }

  return nodes;
};

const genericEmitKind = (event: LedgerEvent): TelemetryEmitKind | undefined => {
  if (event.kind.startsWith("dispatch.")) return "backend";
  if (event.kind.startsWith("durable_trigger.")) return "carrier";
  if (event.kind.startsWith("verification.") || event.kind.includes(".verification.")) {
    return "carrier";
  }
  return undefined;
};

const genericNodeName = (event: LedgerEvent): string => {
  if (event.kind.startsWith("dispatch.")) return "dispatch.delivery";
  if (event.kind.startsWith("durable_trigger.")) return "durable_trigger.step";
  if (event.kind.startsWith("verification.") || event.kind.includes(".verification.")) {
    return "verification.gate";
  }
  return event.kind;
};

const genericTelemetryNodes = (
  events: ReadonlyArray<LedgerEvent>,
): ReadonlyArray<TelemetryEventNode> =>
  events.flatMap((event) => {
    const emitKind = genericEmitKind(event);
    if (emitKind === undefined) return [];
    return [
      telemetryNode({
        event,
        emitKind,
        name: genericNodeName(event),
        traceContext: traceContextFromPayload(event.payload),
        attributes: {
          "agentos.event.kind": event.kind,
          "agentos.event.scope_key": scopeRefKey(event.scopeRef),
          "agentos.event.fact_owner": factOwnerKey(event.factOwnerRef),
          "agentos.event.effect_authority": authorityRefKey(event.effectAuthorityRef),
          "agentos.event.id": event.id,
        },
      }),
    ];
  });

export const projectTelemetryEventTree = (
  events: ReadonlyArray<LedgerEvent>,
): TelemetryEventTree => ({
  nodes: [...runtimeTelemetryNodes(events), ...genericTelemetryNodes(events)].sort(
    (left, right) => (left.ledgerEventId ?? 0) - (right.ledgerEventId ?? 0),
  ),
});
