import { Context, Data, Effect } from "effect";
import { JsonStringifyError } from "@agent-os/core/errors";
import {
  decodeRecordedLedgerEvent,
  type EventQueryOptions,
  type LedgerEvent,
  type RecordedLedgerEvent,
} from "@agent-os/core/types";
import type { LedgerCommitEventSpec, LedgerTruthIdentity } from "@agent-os/core/runtime-protocol";

export type RuntimeStorageOperation =
  | "admission"
  | "attached_stream"
  | "boundary_event"
  | "dispatch"
  | "driver"
  | "ledger_commit"
  | "ledger_events"
  | "ledger_stream_snapshot"
  | "projection"
  | "quota"
  | "resource"
  | "scheduler"
  | "submit"
  | "trigger"
  | "workspace_job";

export class RuntimeStorageError extends Data.TaggedError("agent_os.runtime_storage_error")<{
  readonly operation: RuntimeStorageOperation;
  readonly cause: unknown;
}> {}

export const runtimeStorageError = (
  operation: RuntimeStorageOperation,
  cause: unknown,
): RuntimeStorageError =>
  cause instanceof RuntimeStorageError ? cause : new RuntimeStorageError({ operation, cause });

export const runtimeStorageOrJsonError = (
  operation: RuntimeStorageOperation,
  cause: unknown,
): RuntimeStorageError | JsonStringifyError =>
  cause instanceof JsonStringifyError ? cause : runtimeStorageError(operation, cause);

export const recordLedgerPortEvents = (
  operation: RuntimeStorageOperation,
  events: ReadonlyArray<LedgerEvent>,
): Effect.Effect<ReadonlyArray<RecordedLedgerEvent>, RuntimeStorageError> =>
  Effect.try({
    try: () => events.map(decodeRecordedLedgerEvent),
    catch: (cause) => runtimeStorageError(operation, cause),
  }).pipe(Effect.withSpan("agentos.runtime.ledger.record_events"));

export const recordLedgerPortEvent = (
  operation: RuntimeStorageOperation,
  event: LedgerEvent,
): Effect.Effect<RecordedLedgerEvent, RuntimeStorageError> =>
  Effect.try({
    try: () => decodeRecordedLedgerEvent(event),
    catch: (cause) => runtimeStorageError(operation, cause),
  }).pipe(Effect.withSpan("agentos.runtime.ledger.record_event"));

export type LedgerPreparedEventRef = {
  readonly key: string;
};

export type LedgerPreparedPayloadContext = {
  readonly id: (ref: LedgerPreparedEventRef) => number;
};

export type LedgerPreparedEventSpec =
  | (Omit<LedgerCommitEventSpec, "payload"> & {
      readonly payload: unknown;
      readonly buildPayload?: never;
    })
  | (Omit<LedgerCommitEventSpec, "payload"> & {
      readonly payload?: never;
      readonly buildPayload: (context: LedgerPreparedPayloadContext) => unknown;
    });

export type LedgerPreparedCommitBuilder = {
  readonly ref: (key: string) => LedgerPreparedEventRef;
  readonly id: (ref: LedgerPreparedEventRef) => number;
  readonly append: {
    (recipe: LedgerPreparedEventSpec): LedgerPreparedEventRef;
    (ref: LedgerPreparedEventRef, recipe: LedgerPreparedEventSpec): LedgerPreparedEventRef;
  };
};

export type LedgerPreparedCommit = (
  build: (builder: LedgerPreparedCommitBuilder) => void,
) => Effect.Effect<ReadonlyArray<RecordedLedgerEvent>, RuntimeStorageError | JsonStringifyError>;

/**
 * Backend-neutral ledger service for atomic fact commits and exact identity reads.
 *
 * @agentosPrimitive primitive.runtime.Ledger
 * @agentosInvariant invariant.ledger.single-commit-source
 * @agentosInvariant invariant.d10.truth-identity
 * @agentosDocs docs/concepts/durable-truth.md
 * @public
 */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly commit: (
      events: ReadonlyArray<LedgerCommitEventSpec>,
    ) => Effect.Effect<
      ReadonlyArray<RecordedLedgerEvent>,
      RuntimeStorageError | JsonStringifyError
    >;
    readonly commitPrepared: LedgerPreparedCommit;
    readonly events: (
      identity: LedgerTruthIdentity,
      opts?: EventQueryOptions,
    ) => Effect.Effect<ReadonlyArray<RecordedLedgerEvent>, RuntimeStorageError>;
    readonly streamSnapshot: (
      identity: LedgerTruthIdentity,
      opts?: Pick<EventQueryOptions, "afterId" | "kinds" | "factOwnerRefs">,
    ) => Effect.Effect<ReadonlyArray<RecordedLedgerEvent>, RuntimeStorageError>;
  }
>()("@agent-os/Ledger") {}
