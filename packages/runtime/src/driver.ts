import { Data, Effect } from "effect";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  type DecisionGateConsumedPayload,
  type DecisionGateRequestedPayload,
} from "@agent-os/decision-gate";
import { SqlError, type JsonStringifyError } from "@agent-os/kernel/errors";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  type RuntimeAbortEventKind,
  type RuntimeEventCommitSpec,
  type RuntimeEventCommitSpecByKind,
  type RuntimeEventKind,
  type RuntimeLedgerEventByKind,
} from "@agent-os/runtime-protocol";
import type { LedgerCommitEventSpec } from "@agent-os/runtime-protocol";
import type { BoundaryCommitRejected } from "./boundary-commit";

class DriverLedgerCommitShapeMismatch extends Data.TaggedError(
  "agent_os.driver_ledger_commit_shape_mismatch",
)<{
  readonly expected: number;
  readonly actual: number;
}> {}

type LedgerAppender = {
  readonly commit: (
    events: ReadonlyArray<LedgerCommitEventSpec>,
  ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError | JsonStringifyError>;
};

type BoundaryEventAppender = {
  readonly commit: (
    contract: typeof decisionGateBoundaryContract,
    event: string,
    payload: unknown,
  ) => Effect.Effect<LedgerEvent, BoundaryCommitRejected | SqlError | JsonStringifyError>;
};

type RuntimeAppendAction<K extends keyof RuntimeEventActionByKind> = {
  readonly kind: K;
  readonly event: RuntimeEventActionByKind[K];
};

type RuntimeEventActionByKind = {
  readonly start: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_STARTED>;
  readonly ingest_chat: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.CHAT_INGESTED>;
  readonly request_llm: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.LLM_REQUESTED>;
  readonly record_llm_response: RuntimeEventCommitSpecByKind<
    typeof RUNTIME_EVENT_KIND.LLM_RESPONSE
  >;
  readonly reject_tool: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.TOOL_REJECTED>;
  readonly compact_history: RuntimeEventCommitSpecByKind<
    typeof RUNTIME_EVENT_KIND.RUNTIME_HISTORY_COMPACTED
  >;
  readonly rekey: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.RUNTIME_REKEYED>;
  readonly record_tool_result: RuntimeEventCommitSpecByKind<
    typeof RUNTIME_EVENT_KIND.TOOL_EXECUTED
  >;
  readonly complete: RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED>;
  readonly abort: RuntimeEventCommitSpecByKind<RuntimeAbortEventKind>;
};

export type RuntimeDriverAction = {
  readonly [K in keyof RuntimeEventActionByKind]: RuntimeAppendAction<K>;
}[keyof RuntimeEventActionByKind];

type RuntimeCommittedEventForSpec<Spec> =
  Spec extends RuntimeEventCommitSpecByKind<infer K> ? RuntimeLedgerEventByKind<K> : never;

type RuntimeCommittedEventsForSpecs<
  Specs extends readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
> = {
  readonly [Index in keyof Specs]: RuntimeCommittedEventForSpec<Specs[Index]>;
} & { readonly length: Specs["length"] };

type RuntimeCommittedEventForAction<K extends keyof RuntimeEventActionByKind> =
  RuntimeCommittedEventForSpec<RuntimeEventActionByKind[K]>;

export type ParkDriverAction = {
  readonly kind: "park";
  readonly request: DecisionGateRequestedPayload;
  readonly interruption: RuntimeEventCommitSpecByKind<
    typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
  >;
};

export type ResumeDriverAction = {
  readonly kind: "resume";
  readonly consumed: DecisionGateConsumedPayload;
  readonly resumed: (
    consumedEventId: number,
  ) => RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED>;
};

export type CompleteAfterToolsDriverAction = {
  readonly kind: "complete_after_tools";
  readonly events: readonly [
    RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS>,
    RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED>,
  ];
};

export type NextDriverAction =
  | RuntimeDriverAction
  | ParkDriverAction
  | ResumeDriverAction
  | CompleteAfterToolsDriverAction;

export type RuntimeDriverActionResult<
  K extends RuntimeDriverAction["kind"] = RuntimeDriverAction["kind"],
> = K extends keyof RuntimeEventActionByKind
  ? {
      readonly kind: K;
      readonly event: RuntimeCommittedEventForAction<K>;
    }
  : never;

export type CompleteAfterToolsDriverActionResult = {
  readonly kind: "complete_after_tools";
  readonly events: readonly [
    RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.RUNTIME_COMPLETED_AFTER_TOOLS>,
    RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_COMPLETED>,
  ];
};

export type DriverActionResult =
  | RuntimeDriverActionResult
  | {
      readonly kind: "park";
      readonly request: LedgerEvent;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
    }
  | {
      readonly kind: "resume";
      readonly consumed: LedgerEvent;
      readonly resumed: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED>;
    }
  | CompleteAfterToolsDriverActionResult;

const decodeCommittedRuntimeEvent = <K extends RuntimeEventKind>(
  event: LedgerEvent,
  expectedKind: K,
): Effect.Effect<RuntimeLedgerEventByKind<K>, SqlError> =>
  Effect.gen(function* () {
    const decoded = decodeRuntimeLedgerEvent(event);
    if (decoded._tag === "runtime" && decoded.event.kind === expectedKind) {
      return decoded.event as RuntimeLedgerEventByKind<K>;
    }
    return yield* Effect.fail(
      new SqlError({
        cause: {
          reason: "driver_ledger_commit_runtime_decode_mismatch",
          expectedKind,
          actualKind: event.kind,
        },
      }),
    );
  });

const commitOneRuntimeEvent = <K extends RuntimeEventKind>(
  ledger: LedgerAppender,
  spec: RuntimeEventCommitSpecByKind<K>,
): Effect.Effect<RuntimeLedgerEventByKind<K>, SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const events = yield* ledger.commit([spec]);
    const event = events[0];
    if (event === undefined) {
      return yield* Effect.fail(
        new SqlError({
          cause: new DriverLedgerCommitShapeMismatch({ expected: 1, actual: 0 }),
        }),
      );
    }
    return yield* decodeCommittedRuntimeEvent(event, spec.kind);
  }) as Effect.Effect<RuntimeLedgerEventByKind<K>, SqlError | JsonStringifyError>;

const commitRuntimeEvents = <
  T extends readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
>(
  ledger: LedgerAppender,
  specs: T,
): Effect.Effect<RuntimeCommittedEventsForSpecs<T>, SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const events = yield* ledger.commit(specs);
    if (events.length !== specs.length) {
      return yield* Effect.fail(
        new SqlError({
          cause: new DriverLedgerCommitShapeMismatch({
            expected: specs.length,
            actual: events.length,
          }),
        }),
      );
    }
    const decoded: RuntimeLedgerEventByKind<RuntimeEventKind>[] = [];
    for (const [index, spec] of specs.entries()) {
      decoded.push(yield* decodeCommittedRuntimeEvent(events[index] as LedgerEvent, spec.kind));
    }
    return decoded as unknown as RuntimeCommittedEventsForSpecs<T>;
  });

export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: RuntimeDriverAction,
): Effect.Effect<RuntimeDriverActionResult, SqlError | JsonStringifyError>;
export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: CompleteAfterToolsDriverAction,
): Effect.Effect<CompleteAfterToolsDriverActionResult, SqlError | JsonStringifyError>;
export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: RuntimeDriverAction | CompleteAfterToolsDriverAction,
): Effect.Effect<
  RuntimeDriverActionResult | CompleteAfterToolsDriverActionResult,
  SqlError | JsonStringifyError
> {
  return Effect.gen(function* () {
    if (action.kind === "complete_after_tools") {
      const events = yield* commitRuntimeEvents(ledger, action.events);
      return {
        kind: "complete_after_tools",
        events: [events[0], events[1]],
      } as CompleteAfterToolsDriverActionResult;
    }
    const event = yield* commitOneRuntimeEvent(ledger, action.event);
    return { kind: action.kind, event } as RuntimeDriverActionResult;
  });
}

export const appendNextDriverAction = (
  services: {
    readonly ledger: LedgerAppender;
    readonly boundaryEvents: BoundaryEventAppender;
  },
  action: NextDriverAction,
): Effect.Effect<DriverActionResult, BoundaryCommitRejected | SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    switch (action.kind) {
      case "park": {
        const request = yield* services.boundaryEvents.commit(
          decisionGateBoundaryContract,
          DECISION_GATE_KIND.REQUESTED,
          action.request,
        );
        const interruption = yield* commitOneRuntimeEvent(services.ledger, action.interruption);
        return { kind: "park", request, interruption };
      }
      case "resume": {
        const consumed = yield* services.boundaryEvents.commit(
          decisionGateBoundaryContract,
          DECISION_GATE_KIND.CONSUMED,
          action.consumed,
        );
        const resumed = yield* commitOneRuntimeEvent(services.ledger, action.resumed(consumed.id));
        return { kind: "resume", consumed, resumed };
      }
      case "complete_after_tools": {
        return yield* appendRuntimeDriverAction(services.ledger, action);
      }
      default: {
        return yield* appendRuntimeDriverAction(services.ledger, action);
      }
    }
  });
