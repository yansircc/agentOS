import { Data, Duration, Effect } from "effect";
import { ABORT } from "@agent-os/core/abort";
import type { JsonStringifyError } from "@agent-os/core/errors";
import type { LedgerTruthIdentity, SubmitResult, TurnRef } from "@agent-os/core/runtime-protocol";
import type { TraceContext } from "@agent-os/core/telemetry-protocol";
import { Ledger, type RuntimeStorageError } from "../ledger";
import { finalAbort } from "./result";

export const DEFAULT_LLM_CALL_TIMEOUT_MS = 60_000;

export const turnRefOf = (runId: number, index: number): TurnRef => ({
  id: runId,
  index,
});

export class LlmCallTimedOut extends Data.TaggedError("agent_os.llm_call_timed_out")<{
  readonly mode: "budget" | "provider";
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}> {}

export const llmTimeoutFor = (
  startTime: number,
  now: number,
  budgetTimeMs: number,
  llmCallTimeoutMs: number,
):
  | {
      readonly ok: true;
      readonly mode: "budget" | "provider";
      readonly timeoutMs: number;
    }
  | {
      readonly ok: false;
      readonly elapsedMs: number;
    } => {
  const elapsedMs = now - startTime;
  if (Number.isFinite(budgetTimeMs)) {
    const remaining = budgetTimeMs - elapsedMs;
    if (remaining <= 0) return { ok: false, elapsedMs };
    if (remaining <= llmCallTimeoutMs) {
      return { ok: true, mode: "budget", timeoutMs: remaining };
    }
  }
  return { ok: true, mode: "provider", timeoutMs: llmCallTimeoutMs };
};

export const llmCallTimeoutBudgetMs = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : DEFAULT_LLM_CALL_TIMEOUT_MS;

export const timeoutAbortResult = (
  timeout: LlmCallTimedOut,
  identity: LedgerTruthIdentity,
  runId: number,
  tokensUsed: number,
  traceContext?: TraceContext,
): Effect.Effect<SubmitResult, RuntimeStorageError | JsonStringifyError, Ledger> => {
  if (timeout.mode === "budget") {
    return finalAbort(
      ABORT.BUDGET_TIME,
      { elapsedMs: timeout.elapsedMs, maxMs: timeout.timeoutMs },
      identity,
      runId,
      tokensUsed,
      traceContext,
    );
  }
  return finalAbort(
    ABORT.UPSTREAM_FAILURE,
    { cause: "provider_timeout", timeoutMs: timeout.timeoutMs },
    identity,
    runId,
    tokensUsed,
    traceContext,
  );
};

export const isLlmCallTimedOut = (error: unknown): error is LlmCallTimedOut =>
  error instanceof LlmCallTimedOut;

export type LlmTimeoutWindow = Extract<ReturnType<typeof llmTimeoutFor>, { readonly ok: true }>;

const abortLlmController = (controller: AbortController, reason: string): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!controller.signal.aborted) controller.abort(reason);
  });

const llmTimeoutError = (timeout: LlmTimeoutWindow, budgetTimeMs: number): LlmCallTimedOut =>
  new LlmCallTimedOut({
    mode: timeout.mode,
    elapsedMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
    timeoutMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
  });

export const runTimedLlmAttempt = <A, E, R>(
  timeout: LlmTimeoutWindow,
  budgetTimeMs: number,
  attempt: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LlmCallTimedOut, R> =>
  Effect.gen(function* () {
    const controller = new AbortController();
    return yield* attempt(controller.signal).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeout.timeoutMs),
        orElse: () => Effect.fail(llmTimeoutError(timeout, budgetTimeMs)),
      }),
      Effect.tapError((error) =>
        abortLlmController(
          controller,
          isLlmCallTimedOut(error) ? "agent_os.llm_call_timeout" : "agent_os.llm_stream_failed",
        ),
      ),
      Effect.onInterrupt(() => abortLlmController(controller, "llm_call_interrupted")),
    );
  });
