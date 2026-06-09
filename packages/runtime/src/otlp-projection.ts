import { authorityRefKey, factOwnerKey, scopeRefKey } from "@agent-os/kernel/effect-claim";
import type { LedgerEvent } from "@agent-os/kernel/types";
import { validateOptionalTraceContext, type TraceContext } from "@agent-os/telemetry-protocol";
import { Option } from "effect";
import { ABORT } from "./abort";
import {
  decodeRuntimeLedgerEvent,
  isRuntimeAbortEventKind,
  RUNTIME_EVENT_KIND,
  type RuntimeLedgerEvent,
} from "./runtime-events";

export const OTLP_GENAI_SEMCONV_MAPPING_VERSION = "agent-os-otlp-genai-v1";

export type OtlpAttributeValue = string | number | boolean;

export interface OtlpProjectionSpan {
  readonly name: string;
  readonly kind:
    | "agent_run"
    | "llm_call"
    | "tool_execution"
    | "dispatch_delivery"
    | "durable_trigger"
    | "verification_gate";
  readonly traceId?: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTimeUnixNano: number;
  readonly endTimeUnixNano: number;
  readonly status: "OK" | "ERROR" | "UNSET";
  readonly attributes: Readonly<Record<string, OtlpAttributeValue>>;
  readonly sourceEventIds: ReadonlyArray<number>;
}

export interface OtlpProjection {
  readonly mappingVersion: typeof OTLP_GENAI_SEMCONV_MAPPING_VERSION;
  readonly spans: ReadonlyArray<OtlpProjectionSpan>;
}

const tsNanos = (ts: number): number => Math.max(0, Math.floor(ts)) * 1_000_000;

const spanIdFromEventId = (id: number, salt = 0): string =>
  (BigInt(Math.max(1, Math.floor(id))) + (BigInt(salt) << 48n))
    .toString(16)
    .padStart(16, "0")
    .slice(-16);

const traceContextParts = (
  traceContext: TraceContext | undefined,
): { readonly traceId?: string; readonly parentSpanId?: string } => {
  if (traceContext === undefined) return {};
  const [, traceId, parentSpanId] = traceContext.traceparent.split("-");
  return {
    ...(traceId === undefined ? {} : { traceId }),
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const traceContextFromPayload = (payload: unknown): TraceContext | undefined => {
  if (!isRecord(payload)) return undefined;
  const parsed = validateOptionalTraceContext(payload.traceContext);
  if (!parsed.ok) {
    return Option.getOrThrowWith(
      Option.none(),
      () => new TypeError(`traceContext malformed: ${parsed.reason}`),
    );
  }
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

const runtimeSpans = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<OtlpProjectionSpan> => {
  const runtimeEvents = runtimeEventsOf(events);
  const spans: OtlpProjectionSpan[] = [];
  for (const start of runtimeEvents) {
    if (start.kind !== RUNTIME_EVENT_KIND.AGENT_RUN_STARTED) continue;
    const terminal = terminalForRun(runtimeEvents, start.id);
    const traceContext = runtimeTraceContext(runtimeEvents, start);
    spans.push({
      name: "agent.run",
      kind: "agent_run",
      ...traceContextParts(traceContext),
      spanId: spanIdFromEventId(start.id),
      startTimeUnixNano: tsNanos(start.ts),
      endTimeUnixNano: tsNanos(terminal?.ts ?? start.ts),
      status:
        terminal === undefined
          ? "UNSET"
          : terminal.kind === RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED
            ? "OK"
            : "ERROR",
      attributes: {
        "agentos.mapping.version": OTLP_GENAI_SEMCONV_MAPPING_VERSION,
        "agentos.run.id": start.id,
        "agentos.event.kind": start.kind,
      },
      sourceEventIds: terminal === undefined ? [start.id] : [start.id, terminal.id],
    });
  }

  for (const event of runtimeEvents) {
    if (event.kind === RUNTIME_EVENT_KIND.LLM_RESPONSE) {
      const traceContext = runtimeTraceContext(runtimeEvents, event);
      spans.push({
        name: "gen_ai.call",
        kind: "llm_call",
        ...traceContextParts(traceContext),
        spanId: spanIdFromEventId(event.id),
        startTimeUnixNano: tsNanos(event.ts),
        endTimeUnixNano: tsNanos(event.ts),
        status: "OK",
        attributes: {
          "gen_ai.operation.name": "chat",
          "agentos.run.id": event.payload.turn.id,
          "agentos.turn.index": event.payload.turn.index,
          "gen_ai.usage.input_tokens": event.payload.usage.promptTokens,
          "gen_ai.usage.output_tokens": event.payload.usage.completionTokens,
          "agentos.event.kind": event.kind,
        },
        sourceEventIds: [event.id],
      });
      continue;
    }
    if (
      event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED ||
      event.kind === RUNTIME_EVENT_KIND.TOOL_REJECTED
    ) {
      const traceContext = runtimeTraceContext(runtimeEvents, event);
      const domain =
        event.payload.execution.kind === "effectful" ? event.payload.execution.domain : undefined;
      spans.push({
        name: "tool.execute",
        kind: "tool_execution",
        ...traceContextParts(traceContext),
        spanId: spanIdFromEventId(event.id),
        startTimeUnixNano: tsNanos(event.ts),
        endTimeUnixNano: tsNanos(event.ts),
        status: event.kind === RUNTIME_EVENT_KIND.TOOL_EXECUTED ? "OK" : "ERROR",
        attributes: {
          "agentos.run.id": event.payload.runId,
          "agentos.tool.name": event.payload.name,
          "agentos.tool.execution.kind": event.payload.execution.kind,
          ...(domain === undefined
            ? {}
            : {
                "agentos.execution_domain.kind": domain.kind,
                "agentos.execution_domain.ref": domain.ref,
              }),
          "agentos.event.kind": event.kind,
        },
        sourceEventIds: [event.id],
      });
    }
  }
  return spans;
};

const genericSpanKind = (event: LedgerEvent): OtlpProjectionSpan["kind"] | undefined => {
  if (event.kind.startsWith("dispatch.")) return "dispatch_delivery";
  if (event.kind.startsWith("durable_trigger.")) return "durable_trigger";
  if (event.kind.startsWith("verification.") || event.kind.includes(".verification.")) {
    return "verification_gate";
  }
  return undefined;
};

const genericSpanName = (kind: OtlpProjectionSpan["kind"]): string => {
  switch (kind) {
    case "dispatch_delivery":
      return "dispatch.delivery";
    case "durable_trigger":
      return "durable_trigger.step";
    case "verification_gate":
      return "verification.gate";
    case "agent_run":
    case "llm_call":
    case "tool_execution":
      return kind;
  }
};

const genericSpans = (events: ReadonlyArray<LedgerEvent>): ReadonlyArray<OtlpProjectionSpan> =>
  events.flatMap((event) => {
    const kind = genericSpanKind(event);
    if (kind === undefined) return [];
    const traceContext = traceContextFromPayload(event.payload);
    return [
      {
        name: genericSpanName(kind),
        kind,
        ...traceContextParts(traceContext),
        spanId: spanIdFromEventId(event.id),
        startTimeUnixNano: tsNanos(event.ts),
        endTimeUnixNano: tsNanos(event.ts),
        status:
          event.kind.endsWith(".failed") || event.kind.endsWith(".cancelled") ? "ERROR" : "OK",
        attributes: {
          "agentos.event.kind": event.kind,
          "agentos.event.scope_key": scopeRefKey(event.scopeRef),
          "agentos.event.fact_owner": factOwnerKey(event.factOwnerRef),
          "agentos.event.effect_authority": authorityRefKey(event.effectAuthorityRef),
          "agentos.event.id": event.id,
        },
        sourceEventIds: [event.id],
      },
    ];
  });

export const projectOtlpSpans = (events: ReadonlyArray<LedgerEvent>): OtlpProjection => ({
  mappingVersion: OTLP_GENAI_SEMCONV_MAPPING_VERSION,
  spans: [...runtimeSpans(events), ...genericSpans(events)].sort(
    (left, right) => left.sourceEventIds[0]! - right.sourceEventIds[0]!,
  ),
});
