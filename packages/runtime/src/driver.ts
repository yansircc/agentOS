import { Data, Effect } from "effect";
import {
  DECISION_GATE_KIND,
  decisionGateBoundaryContract,
  type DecisionGateConsumedPayload,
  type DecisionGateRequestedPayload,
} from "./decision-gate";
import type { JsonStringifyError } from "@agent-os/core/errors";
import type { RecordedLedgerEvent } from "@agent-os/core/types";
import {
  decodeRuntimeLedgerEvent,
  RUNTIME_EVENT_KIND,
  type RuntimeAbortEventKind,
  type RuntimeEventCommitSpec,
  type RuntimeEventCommitSpecByKind,
  type RuntimeEventKind,
  type RuntimeLedgerEventByKind,
} from "@agent-os/core/runtime-protocol";
import type { LedgerCommitEventSpec } from "@agent-os/core/runtime-protocol";
import type { BoundaryCommitRejected } from "./boundary-commit";
import { runtimeStorageError, type LedgerPreparedCommit, type RuntimeStorageError } from "./ledger";

class DriverLedgerCommitShapeMismatch extends Data.TaggedError(
  "agent_os.driver_ledger_commit_shape_mismatch",
)<{
  readonly expected: number;
  readonly actual: number;
}> {}

type LedgerAppender = {
  readonly commit: (
    events: ReadonlyArray<LedgerCommitEventSpec>,
  ) => Effect.Effect<ReadonlyArray<RecordedLedgerEvent>, RuntimeStorageError | JsonStringifyError>;
  readonly commitPrepared: LedgerPreparedCommit;
};

type BoundaryEventAppender = {
  readonly commit: (
    contract: typeof decisionGateBoundaryContract,
    event: string,
    payload: unknown,
  ) => Effect.Effect<
    RecordedLedgerEvent,
    BoundaryCommitRejected | RuntimeStorageError | JsonStringifyError
  >;
  readonly commitWithRuntimeEvents: (
    contract: typeof decisionGateBoundaryContract,
    event: string,
    payload: unknown,
    runtimeEvents: (
      boundaryEventId: number,
    ) => readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
  ) => Effect.Effect<
    readonly [RecordedLedgerEvent, ...RecordedLedgerEvent[]],
    BoundaryCommitRejected | RuntimeStorageError | JsonStringifyError
  >;
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

type ProductLinkEventCommitSpec =
  | RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED>
  | RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED>
  | RuntimeEventCommitSpecByKind<typeof RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED>;

export type StartWithProductLinkDriverAction = {
  readonly kind: "start_with_product_link";
  readonly start: RuntimeEventActionByKind["start"];
  readonly productLink: (runId: number) => ProductLinkEventCommitSpec;
};

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
  | StartWithProductLinkDriverAction
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
      readonly kind: "start_with_product_link";
      readonly event: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_STARTED>;
      readonly productLink:
        | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_SESSION_TURN_SUBMITTED>
        | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.WORKFLOW_RUN_SUBMITTED>
        | RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.PRODUCT_RUN_LINKED>;
    }
  | {
      readonly kind: "park";
      readonly request: RecordedLedgerEvent;
      readonly interruption: RuntimeLedgerEventByKind<
        typeof RUNTIME_EVENT_KIND.AGENT_RUN_INTERRUPTED
      >;
    }
  | {
      readonly kind: "resume";
      readonly consumed: RecordedLedgerEvent;
      readonly resumed: RuntimeLedgerEventByKind<typeof RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED>;
    }
  | CompleteAfterToolsDriverActionResult;

const decodeCommittedRuntimeEvent = <K extends RuntimeEventKind>(
  event: RecordedLedgerEvent,
  expectedKind: K,
): Effect.Effect<RuntimeLedgerEventByKind<K>, RuntimeStorageError> =>
  Effect.gen(function* () {
    const decoded = decodeRuntimeLedgerEvent(event);
    if (decoded._tag === "runtime" && decoded.event.kind === expectedKind) {
      return decoded.event as RuntimeLedgerEventByKind<K>;
    }
    return yield* Effect.fail(
      runtimeStorageError("driver", {
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
): Effect.Effect<RuntimeLedgerEventByKind<K>, RuntimeStorageError | JsonStringifyError> =>
  Effect.gen(function* () {
    const events = yield* ledger.commit([spec]);
    const event = events[0];
    if (event === undefined) {
      return yield* Effect.fail(
        runtimeStorageError(
          "driver",
          new DriverLedgerCommitShapeMismatch({ expected: 1, actual: 0 }),
        ),
      );
    }
    return yield* decodeCommittedRuntimeEvent(event, spec.kind);
  }) as Effect.Effect<RuntimeLedgerEventByKind<K>, RuntimeStorageError | JsonStringifyError>;

const commitRuntimeEvents = <
  T extends readonly [RuntimeEventCommitSpec, ...RuntimeEventCommitSpec[]],
>(
  ledger: LedgerAppender,
  specs: T,
): Effect.Effect<RuntimeCommittedEventsForSpecs<T>, RuntimeStorageError | JsonStringifyError> =>
  Effect.gen(function* () {
    const events = yield* ledger.commit(specs);
    if (events.length !== specs.length) {
      return yield* Effect.fail(
        runtimeStorageError(
          "driver",
          new DriverLedgerCommitShapeMismatch({
            expected: specs.length,
            actual: events.length,
          }),
        ),
      );
    }
    const decoded: RuntimeLedgerEventByKind<RuntimeEventKind>[] = [];
    for (const [index, spec] of specs.entries()) {
      decoded.push(
        yield* decodeCommittedRuntimeEvent(events[index] as RecordedLedgerEvent, spec.kind),
      );
    }
    return decoded as unknown as RuntimeCommittedEventsForSpecs<T>;
  });

const commitStartWithProductLink = (
  ledger: LedgerAppender,
  action: StartWithProductLinkDriverAction,
): Effect.Effect<
  Extract<DriverActionResult, { readonly kind: "start_with_product_link" }>,
  RuntimeStorageError | JsonStringifyError
> =>
  Effect.gen(function* () {
    const events = yield* ledger.commitPrepared((tx) => {
      const startRef = tx.ref("agent.run.started");
      tx.append(startRef, action.start);
      const productLinkShape = action.productLink(1);
      tx.append({
        kind: productLinkShape.kind,
        scopeRef: productLinkShape.scopeRef,
        effectAuthorityRef: productLinkShape.effectAuthorityRef,
        buildPayload: (context) => action.productLink(context.id(startRef)).payload,
      });
    });
    if (events.length !== 2) {
      return yield* Effect.fail(
        runtimeStorageError(
          "driver",
          new DriverLedgerCommitShapeMismatch({ expected: 2, actual: events.length }),
        ),
      );
    }
    const start = yield* decodeCommittedRuntimeEvent(
      events[0] as RecordedLedgerEvent,
      RUNTIME_EVENT_KIND.AGENT_RUN_STARTED,
    );
    const linkSpec = action.productLink(start.id);
    const productLink = yield* decodeCommittedRuntimeEvent(
      events[1] as RecordedLedgerEvent,
      linkSpec.kind,
    );
    return { kind: "start_with_product_link", event: start, productLink } as Extract<
      DriverActionResult,
      { readonly kind: "start_with_product_link" }
    >;
  });

export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: RuntimeDriverAction,
): Effect.Effect<RuntimeDriverActionResult, RuntimeStorageError | JsonStringifyError>;
export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: StartWithProductLinkDriverAction,
): Effect.Effect<
  Extract<DriverActionResult, { readonly kind: "start_with_product_link" }>,
  RuntimeStorageError | JsonStringifyError
>;
export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: CompleteAfterToolsDriverAction,
): Effect.Effect<CompleteAfterToolsDriverActionResult, RuntimeStorageError | JsonStringifyError>;
export function appendRuntimeDriverAction(
  ledger: LedgerAppender,
  action: RuntimeDriverAction | CompleteAfterToolsDriverAction | StartWithProductLinkDriverAction,
): Effect.Effect<
  RuntimeDriverActionResult | CompleteAfterToolsDriverActionResult | DriverActionResult,
  RuntimeStorageError | JsonStringifyError
> {
  return Effect.withSpan("agentos.runtime.driver.append_runtime_action")(
    Effect.gen(function* () {
      if (action.kind === "start_with_product_link") {
        return yield* commitStartWithProductLink(ledger, action);
      }
      if (action.kind === "complete_after_tools") {
        const events = yield* commitRuntimeEvents(ledger, action.events);
        return {
          kind: "complete_after_tools",
          events: [events[0], events[1]],
        } as CompleteAfterToolsDriverActionResult;
      }
      const event = yield* commitOneRuntimeEvent(ledger, action.event);
      return { kind: action.kind, event } as RuntimeDriverActionResult;
    }),
  );
}

export const appendNextDriverAction = (
  services: {
    readonly ledger: LedgerAppender;
    readonly boundaryEvents: BoundaryEventAppender;
  },
  action: NextDriverAction,
): Effect.Effect<
  DriverActionResult,
  BoundaryCommitRejected | RuntimeStorageError | JsonStringifyError
> =>
  Effect.withSpan("agentos.runtime.driver.append_next_action")(
    Effect.gen(function* () {
      switch (action.kind) {
        case "park": {
          const events = yield* services.boundaryEvents.commitWithRuntimeEvents(
            decisionGateBoundaryContract,
            DECISION_GATE_KIND.REQUESTED,
            action.request,
            () => [action.interruption],
          );
          const request = events[0];
          const interruption = yield* decodeCommittedRuntimeEvent(
            events[1] as RecordedLedgerEvent,
            action.interruption.kind,
          );
          return { kind: "park", request, interruption };
        }
        case "resume": {
          const events = yield* services.boundaryEvents.commitWithRuntimeEvents(
            decisionGateBoundaryContract,
            DECISION_GATE_KIND.CONSUMED,
            action.consumed,
            (consumedEventId) => [action.resumed(consumedEventId)],
          );
          const consumed = events[0];
          const resumed = yield* decodeCommittedRuntimeEvent(
            events[1] as RecordedLedgerEvent,
            RUNTIME_EVENT_KIND.AGENT_RUN_RESUMED,
          );
          return { kind: "resume", consumed, resumed };
        }
        case "start_with_product_link": {
          return yield* appendRuntimeDriverAction(services.ledger, action);
        }
        case "complete_after_tools": {
          return yield* appendRuntimeDriverAction(services.ledger, action);
        }
        default: {
          return yield* appendRuntimeDriverAction(services.ledger, action);
        }
      }
    }),
  );
