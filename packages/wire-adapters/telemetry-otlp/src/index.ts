import type {
  TelemetryAttributeValue,
  TelemetryEventKind,
  TelemetryEventNode,
  TelemetryEventTree,
  TelemetryOutcome,
  TraceContext,
} from "@agent-os/telemetry-protocol";

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

const tsNanos = (ts: number | undefined): number => Math.max(0, Math.floor(ts ?? 0)) * 1_000_000;

const spanIdFromNumber = (id: number, salt = 0): string =>
  (BigInt(Math.max(1, Math.floor(id))) + (BigInt(salt) << 48n))
    .toString(16)
    .padStart(16, "0")
    .slice(-16);

const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

const spanIdFromString = (value: string): string => {
  let hash = FNV_64_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * FNV_64_PRIME) & UINT64_MASK;
  }
  return (hash === 0n ? 1n : hash).toString(16).padStart(16, "0").slice(-16);
};

const spanIdForNode = (node: TelemetryEventNode): string =>
  node.ledgerEventId === undefined
    ? spanIdFromString(node.id)
    : spanIdFromNumber(node.ledgerEventId);

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

const isOtlpSpanKind = (
  telemetryKind: TelemetryEventKind,
): telemetryKind is OtlpProjectionSpan["kind"] => {
  switch (telemetryKind) {
    case "agent_run":
    case "llm_call":
    case "tool_execution":
    case "dispatch_delivery":
    case "durable_trigger":
    case "verification_gate":
      return true;
    default:
      return false;
  }
};

const otlpSpanKind = (telemetryKind: TelemetryEventKind): OtlpProjectionSpan["kind"] | undefined =>
  isOtlpSpanKind(telemetryKind) ? telemetryKind : undefined;

const otlpStatus = (outcome: TelemetryOutcome | undefined): OtlpProjectionSpan["status"] => {
  switch (outcome) {
    case "ok":
      return "OK";
    case "error":
      return "ERROR";
    case "unset":
    case undefined:
      return "UNSET";
  }
};

const sourceEventIdsForNode = (node: TelemetryEventNode): ReadonlyArray<number> =>
  node.sourceEventIds ?? (node.ledgerEventId === undefined ? [] : [node.ledgerEventId]);

const firstSourceEventId = (source: {
  readonly ledgerEventId?: number;
  readonly sourceEventIds?: ReadonlyArray<number>;
}): number => source.sourceEventIds?.[0] ?? source.ledgerEventId ?? Number.MAX_SAFE_INTEGER;

const copyAttribute = (
  attributes: Record<string, OtlpAttributeValue>,
  key: string,
  value: TelemetryAttributeValue,
): void => {
  if (value !== null) attributes[key] = value;
};

const otlpAttributes = (node: TelemetryEventNode): Readonly<Record<string, OtlpAttributeValue>> => {
  const attributes: Record<string, OtlpAttributeValue> = {
    "agentos.mapping.version": OTLP_GENAI_SEMCONV_MAPPING_VERSION,
  };
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    copyAttribute(attributes, key, value);
  }
  return attributes;
};

export const projectOtlpSpans = (tree: TelemetryEventTree): OtlpProjection => {
  const spanIds = new Map(tree.nodes.map((node) => [node.id, spanIdForNode(node)]));
  const spans: OtlpProjectionSpan[] = [];

  for (const node of tree.nodes) {
    const kind = otlpSpanKind(node.telemetryKind);
    if (kind === undefined) continue;
    const traceContext = traceContextParts(node.traceContext);
    const topologyParentSpanId =
      node.parentId === undefined ? undefined : spanIds.get(node.parentId);
    spans.push({
      name: node.name,
      kind,
      ...traceContext,
      spanId: spanIds.get(node.id) ?? spanIdForNode(node),
      ...(topologyParentSpanId === undefined ? {} : { parentSpanId: topologyParentSpanId }),
      startTimeUnixNano: tsNanos(node.at),
      endTimeUnixNano: tsNanos(node.endedAt ?? node.at),
      status: otlpStatus(node.outcome),
      attributes: otlpAttributes(node),
      sourceEventIds: sourceEventIdsForNode(node),
    });
  }

  return {
    mappingVersion: OTLP_GENAI_SEMCONV_MAPPING_VERSION,
    spans: spans.sort((left, right) => {
      const leftId = firstSourceEventId(left);
      const rightId = firstSourceEventId(right);
      return leftId - rightId;
    }),
  };
};
