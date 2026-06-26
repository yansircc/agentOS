import { authorityRefKey, factOwnerKey, scopeRefKey } from "@agent-os/core/effect-claim";
import type { LedgerEvent } from "@agent-os/core/types";
import { ABORT } from "@agent-os/core/abort";
import { Effect } from "effect";
import {
  InvalidTraceContext,
  validateOptionalTraceContext,
  type TelemetryAttributeValue,
  type TelemetryEmitKind,
  type TelemetryEventKind,
  type TelemetryEventNode,
  type TelemetryEventTree,
  type TelemetryOutcome,
  type TraceContext,
} from "@agent-os/core/telemetry-protocol";
import {
  decodeRuntimeLedgerEvent,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type RuntimeLedgerEvent,
} from "@agent-os/core/runtime-protocol";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const traceContextFromPayload = (
  payload: unknown,
): Effect.Effect<TraceContext | undefined, InvalidTraceContext> => {
  if (!isRecord(payload)) return Effect.succeed(undefined);
  const parsed = validateOptionalTraceContext(payload.traceContext);
  if (!parsed.ok) {
    return Effect.fail(
      new InvalidTraceContext({ position: "dispatch_payload", reason: parsed.reason }),
    );
  }
  return Effect.succeed(parsed.traceContext);
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
    case RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED:
    case RUNTIME_EVENT_KIND.RUNTIME_REKEYED:
    case RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS:
    case RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED:
    case ABORT.BUDGET_TOKENS:
    case ABORT.BUDGET_TIME:
    case ABORT.TOOL_ERROR:
    case ABORT.UPSTREAM_FAILURE:
    case ABORT.RETRIES:
    case ABORT.CLIENT_DISCONNECT:
    case ABORT.DECISION_REJECTED:
    case ABORT.DECISION_CANCELLED:
    case ABORT.DECISION_EXPIRED:
      return event.payload.runId;
    case RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED:
    case RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED:
      return event.payload.runtimeRunId;
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_REQUESTED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_DISPATCHED:
    case RUNTIME_EVENT_KIND.SCHEDULE_FIRE_FAILED:
      throw new TypeError("schedule fire events are not runtime run-bound");
    case RUNTIME_EVENT_KIND.LLM_REQUESTED:
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
): Effect.Effect<TraceContext | undefined, InvalidTraceContext> =>
  Effect.gen(function* () {
    const direct = yield* traceContextFromPayload(event.payload);
    return direct ?? traceContextForRun(runtimeEvents, runIdForRuntimeEvent(event));
  });

const telemetryNode = (spec: {
  readonly event: LedgerEvent;
  readonly telemetryKind: TelemetryEventKind;
  readonly emitKind: TelemetryEmitKind;
  readonly name: string;
  readonly endedAt?: number;
  readonly outcome?: TelemetryOutcome;
  readonly parentId?: string;
  readonly traceContext?: TraceContext;
  readonly sourceEventIds?: ReadonlyArray<number>;
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
}): TelemetryEventNode => ({
  id: `ledger:${spec.event.id}:${spec.name}`,
  ...(spec.parentId === undefined ? {} : { parentId: spec.parentId }),
  telemetryKind: spec.telemetryKind,
  emitKind: spec.emitKind,
  name: spec.name,
  at: spec.event.ts,
  ...(spec.endedAt === undefined ? {} : { endedAt: spec.endedAt }),
  ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
  ...(spec.traceContext === undefined ? {} : { traceContext: spec.traceContext }),
  ledgerEventId: spec.event.id,
  sourceEventIds: spec.sourceEventIds ?? [spec.event.id],
  ...(spec.attributes === undefined ? {} : { attributes: spec.attributes }),
});

const runNodeId = (runId: number): string => `ledger:${runId}:agent.run`;

const runtimeTelemetryNodes = (
  events: ReadonlyArray<LedgerEvent>,
): Effect.Effect<ReadonlyArray<TelemetryEventNode>, InvalidTraceContext> =>
  Effect.gen(function* () {
    const runtimeEvents = runtimeEventsOf(events);
    const nodes: TelemetryEventNode[] = [];

    for (const start of runtimeEvents) {
      if (start.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_STARTED) continue;
      const terminal = terminalForRun(runtimeEvents, start.id);
      nodes.push(
        telemetryNode({
          event: start,
          telemetryKind: "agent_run",
          emitKind: "runtime",
          name: "agent.run",
          endedAt: terminal?.ts,
          outcome:
            terminal === undefined
              ? "unset"
              : terminal.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED
                ? "ok"
                : "error",
          traceContext: yield* runtimeTraceContext(runtimeEvents, start),
          sourceEventIds: terminal === undefined ? [start.id] : [start.id, terminal.id],
          attributes: {
            "agentos.run.id": start.id,
            "agentos.event.kind": start.kind,
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
            telemetryKind: "llm_call",
            emitKind: "provider",
            name: "gen_ai.call",
            endedAt: event.ts,
            outcome: "ok",
            traceContext: yield* runtimeTraceContext(runtimeEvents, event),
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
          event.payload.execution.kind === "external" ? event.payload.execution.domain : undefined;
        nodes.push(
          telemetryNode({
            event,
            parentId: runNodeId(event.payload.runId),
            telemetryKind: "tool_execution",
            emitKind: "runtime",
            name: "tool.execute",
            endedAt: event.ts,
            outcome: event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED ? "ok" : "error",
            traceContext: yield* runtimeTraceContext(runtimeEvents, event),
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
  });

const genericOutcome = (event: LedgerEvent): TelemetryOutcome =>
  event.kind.endsWith(".failed") || event.kind.endsWith(".cancelled") ? "error" : "ok";

const genericTelemetrySemantics = (
  event: LedgerEvent,
):
  | {
      readonly emitKind: TelemetryEmitKind;
      readonly telemetryKind: TelemetryEventKind;
      readonly name: string;
      readonly outcome: TelemetryOutcome;
    }
  | undefined => {
  if (event.kind.startsWith("dispatch.")) {
    return {
      emitKind: "backend",
      telemetryKind: "dispatch_delivery",
      name: "dispatch.delivery",
      outcome: genericOutcome(event),
    };
  }
  if (event.kind.startsWith("durable_trigger.")) {
    return {
      emitKind: "carrier",
      telemetryKind: "durable_trigger",
      name: "durable_trigger.step",
      outcome: genericOutcome(event),
    };
  }
  if (event.kind.startsWith("verification.") || event.kind.includes(".verification.")) {
    return {
      emitKind: "carrier",
      telemetryKind: "verification_gate",
      name: "verification.gate",
      outcome: genericOutcome(event),
    };
  }
  return undefined;
};

const genericTelemetryNodes = (
  events: ReadonlyArray<LedgerEvent>,
): Effect.Effect<ReadonlyArray<TelemetryEventNode>, InvalidTraceContext> =>
  Effect.gen(function* () {
    const nodes: TelemetryEventNode[] = [];
    for (const event of events) {
      const semantics = genericTelemetrySemantics(event);
      if (semantics === undefined) continue;
      nodes.push(
        telemetryNode({
          event,
          telemetryKind: semantics.telemetryKind,
          emitKind: semantics.emitKind,
          name: semantics.name,
          endedAt: event.ts,
          outcome: semantics.outcome,
          traceContext: yield* traceContextFromPayload(event.payload),
          attributes: {
            "agentos.event.kind": event.kind,
            "agentos.event.scope_key": scopeRefKey(event.scopeRef),
            "agentos.event.fact_owner": factOwnerKey(event.factOwnerRef),
            "agentos.event.effect_authority": authorityRefKey(event.effectAuthorityRef),
            "agentos.event.id": event.id,
          },
        }),
      );
    }
    return nodes;
  });

export const projectTelemetryEventTree = (
  events: ReadonlyArray<LedgerEvent>,
): Effect.Effect<TelemetryEventTree, InvalidTraceContext> =>
  Effect.gen(function* () {
    const runtimeNodes = yield* runtimeTelemetryNodes(events);
    const genericNodes = yield* genericTelemetryNodes(events);
    return {
      nodes: [...runtimeNodes, ...genericNodes].sort(
        (left, right) => (left.ledgerEventId ?? 0) - (right.ledgerEventId ?? 0),
      ),
    };
  });
