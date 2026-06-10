import { Context, Data, Effect, Either, Schema } from "effect";

export const TRACE_CONTEXT_VERSION = "w3c-trace-context-v1";

const TRACEPARENT_RE =
  /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;

const TRACESTATE_MEMBER_RE =
  /^[a-z0-9][a-z0-9_.*-]{0,255}(?:@[a-z0-9][a-z0-9_.*-]{0,13})?=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,256}$/;

export interface TraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
}

export type TraceContextValidation =
  | { readonly ok: true; readonly traceContext: TraceContext }
  | { readonly ok: false; readonly reason: string };

export const TraceparentSchema: Schema.Schema<string> = Schema.String.pipe(
  Schema.pattern(TRACEPARENT_RE),
);

const isValidTracestate = (value: string): boolean => {
  if (value.length > 512) return false;
  if (value.length === 0) return true;
  const members = value.split(",");
  if (members.length > 32) return false;
  const keys = new Set<string>();
  for (const raw of members) {
    if (raw !== raw.trim()) return false;
    if (!TRACESTATE_MEMBER_RE.test(raw)) return false;
    const key = raw.slice(0, raw.indexOf("="));
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
};

export const TracestateSchema: Schema.Schema<string> = Schema.String.pipe(
  Schema.filter(isValidTracestate),
);

export const TraceContextSchema: Schema.Schema<TraceContext> = Schema.Struct({
  traceparent: TraceparentSchema,
  tracestate: Schema.optional(TracestateSchema),
});

const traceContextIssue = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "traceContext malformed";

export const validateTraceContext = (value: unknown): TraceContextValidation => {
  const decoded = Either.try({
    try: () => Schema.decodeUnknownSync(TraceContextSchema)(value),
    catch: traceContextIssue,
  });
  if (decoded._tag === "Left") {
    return { ok: false, reason: decoded.left };
  }
  return {
    ok: true,
    traceContext: decoded.right,
  };
};

export const validateOptionalTraceContext = (
  value: unknown,
):
  | { readonly ok: true; readonly traceContext?: TraceContext }
  | { readonly ok: false; readonly reason: string } => {
  if (value === undefined) return { ok: true };
  const parsed = validateTraceContext(value);
  return parsed.ok ? { ok: true, traceContext: parsed.traceContext } : parsed;
};

export const copyTraceContext = (
  traceContext: TraceContext | undefined,
): TraceContext | undefined =>
  traceContext === undefined
    ? undefined
    : {
        traceparent: traceContext.traceparent,
        ...(traceContext.tracestate === undefined ? {} : { tracestate: traceContext.tracestate }),
      };

export class InvalidTraceContext extends Data.TaggedError("agent_os.invalid_trace_context")<{
  readonly position: "submit" | "dispatch" | "dispatch_payload";
  readonly reason: string;
}> {}

export type TelemetryEmitKind =
  | "runtime"
  | "backend"
  | "carrier"
  | "provider"
  | "transport"
  | "wire_adapter"
  | (string & {});

export type TelemetryEventKind =
  | "agent_run"
  | "llm_call"
  | "tool_execution"
  | "dispatch_delivery"
  | "durable_trigger"
  | "verification_gate"
  | (string & {});

export type TelemetryOutcome = "ok" | "error" | "unset";

export type TelemetryAttributeValue = string | number | boolean | null;

export type TelemetryDiagnosticPhase =
  | "sink"
  | "handler"
  | "projection"
  | "dispatch"
  | (string & {});

export interface TelemetryFanoutDiagnostic {
  readonly phase: TelemetryDiagnosticPhase;
  readonly eventId: number;
  readonly kind: string;
  readonly identityKey: string;
  readonly message: string;
}

export interface TelemetryEventNode {
  readonly id: string;
  readonly parentId?: string;
  readonly telemetryKind: TelemetryEventKind;
  readonly emitKind: TelemetryEmitKind;
  readonly name: string;
  readonly at?: number;
  readonly endedAt?: number;
  readonly outcome?: TelemetryOutcome;
  readonly traceContext?: TraceContext;
  readonly ledgerEventId?: number;
  readonly sourceEventIds?: ReadonlyArray<number>;
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
}

export interface TelemetryEventTree {
  readonly nodes: ReadonlyArray<TelemetryEventNode>;
}

export interface TelemetryService {
  readonly emit: (node: TelemetryEventNode) => Effect.Effect<void>;
  readonly eventTree: () => Effect.Effect<TelemetryEventTree>;
}

export class Telemetry extends Context.Tag("@agent-os/Telemetry")<Telemetry, TelemetryService>() {}

const volatileTelemetryAttributeKeys = new Set([
  "agentos.backend.host_id",
  "agentos.backend.instance_id",
  "agentos.duration_ms",
  "agentos.generated.span_id",
  "agentos.span.id",
  "duration_ms",
  "host.id",
  "span.id",
]);

const compareString = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareNumbers = (left: number | undefined, right: number | undefined): number => {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
};

const firstSourceEventId = (node: TelemetryEventNode): number | undefined =>
  node.ledgerEventId ?? node.sourceEventIds?.[0];

const telemetryNodeSortKey = (node: TelemetryEventNode): string =>
  [
    firstSourceEventId(node) ?? Number.MAX_SAFE_INTEGER,
    node.emitKind,
    node.telemetryKind,
    node.name,
    node.id,
  ].join("\u0000");

const sortedAttributes = (
  attributes: Readonly<Record<string, TelemetryAttributeValue>> | undefined,
): Readonly<Record<string, TelemetryAttributeValue>> | undefined => {
  if (attributes === undefined) return undefined;
  const entries = Object.entries(attributes)
    .filter(([key]) => !volatileTelemetryAttributeKeys.has(key))
    .sort(([left], [right]) => compareString(left, right));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
};

const sortedSourceEventIds = (
  sourceEventIds: ReadonlyArray<number> | undefined,
): ReadonlyArray<number> | undefined =>
  sourceEventIds === undefined
    ? undefined
    : [...sourceEventIds].sort((left, right) => left - right);

export const canonicalizeTelemetryEventTree = (tree: TelemetryEventTree): TelemetryEventTree => {
  const ordered = tree.nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const source = compareNumbers(firstSourceEventId(left.node), firstSourceEventId(right.node));
      if (source !== 0) return source;
      const semantic = compareString(
        telemetryNodeSortKey(left.node),
        telemetryNodeSortKey(right.node),
      );
      return semantic === 0 ? left.index - right.index : semantic;
    });
  const ids = new Map<string, string>();
  for (const [index, entry] of ordered.entries()) {
    ids.set(entry.node.id, `telemetry-node:${index + 1}`);
  }
  return {
    nodes: ordered.map(({ node }) => {
      const attributes = sortedAttributes(node.attributes);
      const sourceEventIds = sortedSourceEventIds(node.sourceEventIds);
      return {
        id: ids.get(node.id) ?? node.id,
        ...(node.parentId === undefined
          ? {}
          : { parentId: ids.get(node.parentId) ?? node.parentId }),
        emitKind: node.emitKind,
        telemetryKind: node.telemetryKind,
        name: node.name,
        ...(node.outcome === undefined ? {} : { outcome: node.outcome }),
        ...(node.traceContext === undefined
          ? {}
          : { traceContext: copyTraceContext(node.traceContext) }),
        ...(node.ledgerEventId === undefined ? {} : { ledgerEventId: node.ledgerEventId }),
        ...(sourceEventIds === undefined ? {} : { sourceEventIds }),
        ...(attributes === undefined ? {} : { attributes }),
      };
    }),
  };
};

export const canonicalTelemetryEventTreeJson = (tree: TelemetryEventTree): string =>
  JSON.stringify(canonicalizeTelemetryEventTree(tree));

export const telemetryEventTreesEqual = (
  left: TelemetryEventTree,
  right: TelemetryEventTree,
): boolean => canonicalTelemetryEventTreeJson(left) === canonicalTelemetryEventTreeJson(right);
