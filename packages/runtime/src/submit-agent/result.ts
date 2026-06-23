import { Effect } from "effect";
import type { AbortKind } from "@agent-os/core/abort";
import type { JsonStringifyError } from "@agent-os/core/errors";
import type { LedgerEvent } from "@agent-os/core/types";
import {
  agentRunAbortedEvent,
  type LedgerTruthIdentity,
  type SubmitResult,
} from "@agent-os/core/runtime-protocol";
import type { TraceContext } from "@agent-os/core/telemetry-protocol";
import { appendRuntimeDriverAction } from "../driver";
import { Ledger, runtimeStorageError, type RuntimeStorageError } from "../ledger";
import { projectSubmitResult } from "../run-projector";

export const submitResultFromEvents = (
  events: ReadonlyArray<LedgerEvent>,
  runId: number,
): Effect.Effect<SubmitResult, RuntimeStorageError> => {
  const result = projectSubmitResult(events, runId);
  if (result !== null) return Effect.succeed(result);
  return Effect.fail(
    runtimeStorageError("submit", {
      reason: "missing_terminal_ledger_fact",
      runId,
    }),
  );
};

export const finalAbort = (
  kind: AbortKind,
  payload: Record<string, unknown>,
  identity: LedgerTruthIdentity,
  runId: number,
  tokensUsed: number,
  traceContext?: TraceContext,
): Effect.Effect<SubmitResult, RuntimeStorageError | JsonStringifyError, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* appendRuntimeDriverAction(ledger, {
      kind: "abort",
      event: agentRunAbortedEvent({
        ...identity,
        kind,
        runId,
        tokensUsed,
        payload,
        traceContext,
      }),
    });
    const events = yield* ledger.events(identity);
    return yield* submitResultFromEvents(events, runId);
  });
