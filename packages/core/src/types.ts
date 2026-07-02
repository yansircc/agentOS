/**
 * Plain shared types.
 *
 * LedgerEvent — internal canonical event row shape.
 * LedgerEventRpc — RPC-friendly variant (mutable + payload:any); the shape
 *   passed to user-defined `on()` handlers and returned by `events()`.
 * EventHandler — user-side reactive callback type.
 * ScheduledEventSpec — argument to the runtime client scheduleEvent method.
 */

import { Option, Schema } from "effect";
import {
  isFactOwnerRef,
  type AuthorityRef,
  type FactOwnerRef,
  type ScopeRef,
} from "./effect-claim";
import type { BindingMaterialRef } from "./material-ref";
import { recordedValue } from "./value-brands";
import type { Recorded } from "./value-brands";

export interface DeliveryReceipt {
  readonly anchorId: string;
  readonly anchorKind: "ledger_event" | "external_receipt";
}

/**
 * Canonical durable ledger fact row.
 *
 * @agentosPrimitive primitive.kernel.LedgerEvent
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosInvariant invariant.d10.namespace-integrity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export interface LedgerEvent {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scopeRef: ScopeRef;
  readonly factOwnerRef: FactOwnerRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly payload: unknown;
  readonly scope?: never;
}

export type LedgerEventIdentity = Pick<
  LedgerEvent,
  "scopeRef" | "factOwnerRef" | "effectAuthorityRef"
>;

const ledgerEventId = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)));
const ledgerEventTimestamp = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const NonEmptyStringSchema: Schema.Decoder<string> = Schema.String.pipe(
  Schema.check(Schema.makeFilter((value) => value.length > 0)),
);
const ScopeRefSchema: Schema.Decoder<ScopeRef> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("realm"), scopeId: NonEmptyStringSchema }),
  Schema.Struct({ kind: Schema.Literal("conversation"), scopeId: NonEmptyStringSchema }),
  Schema.Struct({ kind: Schema.Literal("session"), scopeId: NonEmptyStringSchema }),
  Schema.Struct({ kind: Schema.Literal("artifact"), scopeId: NonEmptyStringSchema }),
  Schema.Struct({
    kind: Schema.Literal("external"),
    scopeId: NonEmptyStringSchema,
    systemRef: NonEmptyStringSchema,
  }),
]);
const AuthorityRefSchema: Schema.Decoder<AuthorityRef> = Schema.Struct({
  authorityId: NonEmptyStringSchema,
  authorityClass: NonEmptyStringSchema,
  version: Schema.optional(NonEmptyStringSchema),
});
const FactOwnerRefSchema: Schema.Decoder<FactOwnerRef> = NonEmptyStringSchema.pipe(
  Schema.check(Schema.makeFilter(isFactOwnerRef)),
);

export const LedgerEventSchema: Schema.Decoder<LedgerEvent> = Schema.Struct({
  id: ledgerEventId,
  ts: ledgerEventTimestamp,
  kind: Schema.String,
  scopeRef: ScopeRefSchema,
  factOwnerRef: FactOwnerRefSchema,
  effectAuthorityRef: AuthorityRefSchema,
  payload: Schema.Unknown,
});

export const decodeLedgerEvent = Schema.decodeUnknownSync(LedgerEventSchema);

export type RecordedLedgerEvent = LedgerEvent & Recorded<LedgerEvent>;

const recordLedgerEvent = (event: LedgerEvent): RecordedLedgerEvent =>
  recordedValue(event) as RecordedLedgerEvent;

export const decodeRecordedLedgerEvent = (value: unknown): RecordedLedgerEvent =>
  recordLedgerEvent(decodeLedgerEvent(value));

export const decodeRecordedLedgerEventOption = (
  value: unknown,
): Option.Option<RecordedLedgerEvent> =>
  Option.map(Schema.decodeUnknownOption(LedgerEventSchema)(value), recordLedgerEvent);

export interface LedgerEventRpc {
  id: number;
  ts: number;
  kind: string;
  scopeRef: ScopeRef;
  factOwnerRef: FactOwnerRef;
  effectAuthorityRef: AuthorityRef;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  scope?: never;
}

export type EventHandler = (event: LedgerEventRpc) => Promise<void>;

export interface EventQueryOptions {
  readonly afterId?: number;
  readonly limit?: number;
  readonly kinds?: ReadonlyArray<string>;
  readonly scopeRef?: ScopeRef;
  readonly effectAuthorityRef?: AuthorityRef;
  readonly factOwnerRefs?: ReadonlyArray<FactOwnerRef>;
}

export interface StreamEventsOptions {
  readonly afterId?: number;
  readonly kinds?: ReadonlyArray<string>;
  readonly heartbeatMs?: number;
  readonly scopeRef?: ScopeRef;
  readonly effectAuthorityRef?: AuthorityRef;
  readonly factOwnerRefs?: ReadonlyArray<FactOwnerRef>;
}

export interface ScheduledEventSpec {
  readonly at: number;
  readonly event: string;
  readonly data: unknown;
}

export interface DispatchTargetSpec {
  readonly bindingRef: BindingMaterialRef;
  readonly scopeRef: ScopeRef;
  readonly effectAuthorityRef: AuthorityRef;
  readonly scope?: never;
}

export interface DispatchToScopeSpec {
  readonly target: DispatchTargetSpec;
  readonly event: string;
  readonly data: unknown;
  readonly idempotencyKey: string;
  readonly traceContext?: unknown;
}

export interface DispatchToScopeResult {
  readonly outboundEventId: number;
}

export interface ResourceGrantSpec {
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
}

export interface ResourceReserveSpec {
  readonly key: string;
  readonly amount: number;
  readonly ref: string;
  readonly idempotencyKey: string;
}

export interface ResourceReservationSpec {
  readonly reservationId: string;
  readonly ref: string;
}

export interface ResourceGrantResult {
  readonly eventId: number;
}

export interface ResourceReserveResult {
  readonly reservationId: string;
}

export interface RunTurn {
  readonly index: number;
  readonly at: number;
  readonly text: string;
  readonly usage?: unknown;
}

export interface RunToolCall {
  readonly at: number;
  readonly name: string;
  readonly args: unknown;
  readonly result: unknown;
}

export interface RunTerminal {
  readonly kind: "delivered" | "aborted";
  readonly at: number;
  readonly event: string;
  readonly payload: unknown;
}

export interface RunInterruption {
  readonly at: number;
  readonly event: "agent.run.interrupted";
  readonly interruptId: string;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly reason: string;
  readonly resumeSchema: unknown;
  readonly payload: unknown;
}

export interface RunResume {
  readonly at: number;
  readonly event: "agent.run.resumed";
  readonly interruptId: string;
  readonly turn: {
    readonly id: number;
    readonly index: number;
  };
  readonly resumedAtEventId: number;
  readonly payload: unknown;
}

export interface RunTrace {
  readonly runId: number;
  readonly startedAt: number;
  readonly turns: ReadonlyArray<RunTurn>;
  readonly toolCalls: ReadonlyArray<RunToolCall>;
  readonly interruptions?: ReadonlyArray<RunInterruption>;
  readonly resumes?: ReadonlyArray<RunResume>;
  readonly terminal: RunTerminal | null;
}

export type RunStatus =
  | { readonly kind: "delivered"; readonly at: number; readonly event: string }
  | {
      readonly kind: "aborted";
      readonly at: number;
      readonly abortKind: string;
    }
  | {
      readonly kind: "interrupted";
      readonly at: number;
      readonly event: "agent.run.interrupted";
      readonly interruptId: string;
      readonly reason: string;
    }
  | { readonly kind: "open_without_terminal"; readonly startedAt: number }
  | {
      readonly kind: "orphaned";
      readonly startedAt: number;
      readonly evidence: string;
    };

export type RunStatusKind = RunStatus["kind"];

export interface RunLastKnownEvent {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
}

export type RunRequestStatus =
  | { readonly kind: "none" }
  | {
      readonly kind: "waiting_for_input";
      readonly interruptId: string;
      readonly reason: string;
      readonly at: number;
      readonly descriptor?: unknown;
    };

export type RunCancellationStatus =
  | { readonly kind: "none" }
  | {
      readonly kind: "cancelled";
      readonly at: number;
      readonly event: string;
      readonly reason?: string;
    };

export type RunProductLink =
  | {
      readonly kind: "session_turn";
      readonly eventId: number;
      readonly submittedAt: number;
      readonly sessionRef: string;
      readonly turnRef: string;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: "workflow_run";
      readonly eventId: number;
      readonly submittedAt: number;
      readonly workflowId: string;
      readonly workflowRunId: string;
      readonly idempotencyKey?: string;
      readonly inputDigest?: string;
    }
  | {
      readonly kind: "opaque";
      readonly eventId: number;
      readonly submittedAt: number;
      readonly productRef: string;
      readonly idempotencyKey?: string;
      readonly inputDigest?: string;
    };

export interface RunInspectionDiagnostic {
  readonly source: "telemetry" | "runtime_diagnostic";
  readonly eventId: number;
  readonly kind: string;
  readonly message: string;
  readonly phase?: string;
  readonly identityKey?: string;
  readonly requestedEventId?: number;
  readonly payload?: unknown;
}

export interface RunInspection {
  readonly runId: number;
  readonly status: RunStatus;
  readonly startedAt: number;
  readonly terminal: RunTerminal | null;
  readonly lastKnownEvent?: RunLastKnownEvent;
  readonly request: RunRequestStatus;
  readonly cancellation: RunCancellationStatus;
  readonly productLink?: RunProductLink;
  readonly diagnostics: ReadonlyArray<RunInspectionDiagnostic>;
}

export interface RunSummary {
  readonly runId: number;
  readonly startedAt: number;
  readonly status: RunStatus;
  /** Only present when status.kind ∈ {delivered, aborted}. */
  readonly durationMs?: number;
}

export interface RunListSpec {
  /** Filter to a non-empty subset of RunStatus kinds. Empty/undefined = all. */
  readonly statuses?: ReadonlyArray<RunStatusKind>;
  /** Cursor: return runs strictly older than this runId (DESC pagination). */
  readonly afterRunId?: number;
  /** Page size cap. Caller enforces sane upper bound. */
  readonly limit: number;
}

export interface RunListPage {
  /** Sorted runId DESC (newest first). */
  readonly runs: ReadonlyArray<RunSummary>;
  /** Next afterRunId for continued paging; null when no more pages. */
  readonly nextCursor: number | null;
}

export interface QuotaStateSpec {
  readonly key: string;
  readonly windowMs: number;
  readonly limit: number;
}

export interface QuotaState {
  readonly consumed: number;
  readonly limit: number;
  readonly remaining: number;
  /** v0.3 quota has no refund lifecycle; resource reservations own refunds. */
  readonly refundable: number;
  readonly windowStart?: number;
}

export interface ResourceReservationView {
  readonly id: string;
  readonly amount: number;
}

export interface ResourceState {
  readonly granted: number;
  readonly reserved: number;
  readonly consumed: number;
  readonly available: number;
  readonly reservations: ReadonlyArray<ResourceReservationView>;
}
