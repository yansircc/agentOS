import { Data, Either, Schema } from "effect";

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

export type TelemetryAttributeValue = string | number | boolean | null;

export interface TelemetryEventNode {
  readonly id: string;
  readonly parentId?: string;
  readonly emitKind: TelemetryEmitKind;
  readonly name: string;
  readonly at?: number;
  readonly traceContext?: TraceContext;
  readonly ledgerEventId?: number;
  readonly attributes?: Readonly<Record<string, TelemetryAttributeValue>>;
}

export interface TelemetryEventTree {
  readonly nodes: ReadonlyArray<TelemetryEventNode>;
}
