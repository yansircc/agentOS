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
  RUNTIME_EVENT_KIND,
  type RuntimeAbortEventKind,
  type RuntimeEventCommitSpecByKind,
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

export type RuntimeDriverActionResult = {
  readonly kind: RuntimeDriverAction["kind"];
  readonly event: LedgerEvent;
};

export type CompleteAfterToolsDriverActionResult = {
  readonly kind: "complete_after_tools";
  readonly events: readonly [LedgerEvent, LedgerEvent];
};

export type DriverActionResult =
  | RuntimeDriverActionResult
  | {
      readonly kind: "park";
      readonly request: LedgerEvent;
      readonly interruption: LedgerEvent;
    }
  | {
      readonly kind: "resume";
      readonly consumed: LedgerEvent;
      readonly resumed: LedgerEvent;
    }
  | CompleteAfterToolsDriverActionResult;

const commitOneRuntimeEvent = (
  ledger: LedgerAppender,
  spec: LedgerCommitEventSpec,
): Effect.Effect<LedgerEvent, SqlError | JsonStringifyError> =>
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
    return event;
  });

const commitRuntimeEvents = <
  T extends readonly [LedgerCommitEventSpec, ...LedgerCommitEventSpec[]],
>(
  ledger: LedgerAppender,
  specs: T,
): Effect.Effect<
  ReadonlyArray<LedgerEvent> & { readonly length: T["length"] },
  SqlError | JsonStringifyError
> =>
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
    return events as ReadonlyArray<LedgerEvent> & { readonly length: T["length"] };
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
      return { kind: "complete_after_tools", events: [events[0], events[1]] };
    }
    const event = yield* commitOneRuntimeEvent(ledger, action.event);
    return { kind: action.kind, event };
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
