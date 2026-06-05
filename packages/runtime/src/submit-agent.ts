/**
 * submitAgentEffect — the agent loop.
 *
 * Loop terminates on exactly three conditions:
 *   1. LLM returns no more tool calls (natural stop) -> deliver
 *   2. Any budget dimension exhausted -> abort
 *   3. Tool dispatch retry exhausted -> abort
 *
 * All recoverable failures (UpstreamFailure, ToolError) are caught and
 * funneled through finalAbort, which logs an agent.aborted.* ledger event
 * before returning SubmitResult{ok:false}. Only SqlError | JsonStringifyError
 * escape (irrecoverable infra failures).
 *
 * submitAgentEffect is module-private. Apps call Cloudflare backend.submit(spec)
 * which injects scope from ctx.id.name (SSoT) and runs this effect.
 */

import { Clock, Data, Duration, Effect, Ref } from "effect";
import {
  JsonStringifyError,
  InvalidTraceContext,
  safeStringify,
  safeStringifyPretty,
  SqlError,
  ToolError,
  UpstreamFailure,
} from "@agent-os/kernel/errors";
import {
  textFromLlmOutputItems,
  toolCallsFromLlmOutputItems,
  type LlmMessage,
  type LlmRoute,
  type ToolDefinition,
} from "@agent-os/kernel/llm";
import type { LedgerEvent } from "@agent-os/kernel/types";
import {
  copyTraceContext,
  validateOptionalTraceContext,
  type TraceContext,
} from "@agent-os/kernel/trace-context";
import { ABORT, type AbortKind, reasonOf } from "./abort";
import { LlmTransport } from "./llm-transport";
import { Ledger, type LedgerCommitEventSpec } from "./ledger";
import type { RefResolutionFailed } from "@agent-os/kernel/ref-resolver";
import { Quota } from "./quota-service";
import {
  decodeToolArgs,
  executeTool,
  parseToolCall,
  validateToolRegistry,
  type Tool,
} from "@agent-os/kernel/tools";
import { Admission, makeAdmissionSchemaSpec } from "./admission";
import {
  admitterErrorRejectionRef,
  makeOperationRef,
  makePreClaim,
  normalizeAdmitVerdict,
  type RejectionRef,
} from "@agent-os/kernel/effect-claim";
import type { InternalSubmitSpec, SubmitResult, TurnRef } from "./submit";
import {
  settleToolAdmissionRejected,
  settleToolExecuted,
  settleToolExecutionRejected,
  toolAdmissionFailureCause,
  toolErrorReason,
  publicRuntimeCauseReason,
} from "./tool-settlement";
import {
  agentRunAbortedEvent,
  agentRunCompletedEvent,
  agentRunStartedEvent,
  chatIngestedEvent,
  llmResponseEvent,
  toolExecutedEvent,
  toolRejectedEvent,
  type RuntimeEventCommitSpec,
} from "./runtime-events";

export const DEFAULT_LLM_CALL_TIMEOUT_MS = 60_000;

export const turnRefOf = (runId: number, index: number): TurnRef => ({
  id: runId,
  index,
});

class LlmCallTimedOut extends Data.TaggedError("agent_os.llm_call_timed_out")<{
  readonly mode: "budget" | "provider";
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}> {}

const toolDefinitionsOf = (tools: Record<string, Tool>): ReadonlyArray<ToolDefinition> =>
  Object.values(tools).map((t) => t.definition);

const toolBudgetTimeCause = (
  elapsedMs: number,
  maxMs: number,
): { readonly reason: "budget_time"; readonly elapsedMs: number; readonly maxMs: number } => ({
  reason: "budget_time",
  elapsedMs,
  maxMs,
});

const isToolBudgetTimeError = (error: ToolError): boolean => {
  const cause = error.cause;
  return (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { readonly reason?: unknown }).reason === "budget_time"
  );
};

const toolBudgetTimePayload = (
  error: ToolError,
): { readonly elapsedMs: number; readonly maxMs: number } => {
  const cause = error.cause as { readonly elapsedMs?: unknown; readonly maxMs?: unknown };
  return {
    elapsedMs: typeof cause.elapsedMs === "number" ? cause.elapsedMs : 0,
    maxMs: typeof cause.maxMs === "number" ? cause.maxMs : 0,
  };
};

export const buildInitialMessages = (
  spec: Pick<InternalSubmitSpec, "system" | "intent" | "context">,
): Effect.Effect<ReadonlyArray<LlmMessage>, JsonStringifyError> =>
  Effect.gen(function* () {
    const ctxStr = yield* safeStringifyPretty(spec.context);
    const systemContent =
      spec.system !== undefined
        ? `${spec.system}\n\nContext available:\n${ctxStr}`
        : `You are an agent. Goal: ${spec.intent}\n\nContext available:\n${ctxStr}\n\nUse the provided tools when needed. Reply with a final natural-language answer when you have enough information.`;
    return [
      { role: "system", content: systemContent },
      { role: "user", content: spec.intent },
    ] satisfies ReadonlyArray<LlmMessage>;
  });

const logRuntimeLedgerEvent = (
  ledger: {
    readonly commit: (
      events: ReadonlyArray<LedgerCommitEventSpec>,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError | JsonStringifyError>;
  },
  spec: RuntimeEventCommitSpec,
): Effect.Effect<LedgerEvent, SqlError | JsonStringifyError> =>
  Effect.gen(function* () {
    const events = yield* ledger.commit([spec]);
    const event = events[0];
    if (event === undefined) {
      return yield* Effect.fail(
        new SqlError({ cause: new Error("ledger commit returned no events for single log") }),
      );
    }
    return event;
  });

/** The single termination funnel. All recoverable aborts route through here.
 *  Logs an agent.aborted.* ledger event then constructs SubmitResult.fail. */
const finalAbort = (
  kind: AbortKind,
  payload: Record<string, unknown>,
  scope: string,
  runId: number,
  tokensUsed: number,
  traceContext?: TraceContext,
): Effect.Effect<SubmitResult, SqlError | JsonStringifyError, Ledger> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* logRuntimeLedgerEvent(
      ledger,
      agentRunAbortedEvent({ scope, kind, runId, payload, traceContext }),
    );
    const events = yield* ledger.events(scope);
    return {
      ok: false,
      runId,
      reason: reasonOf(kind),
      eventCount: events.length,
      tokensUsed,
    } as const;
  });

const llmTimeoutFor = (
  startTime: number,
  now: number,
  budgetTimeMs: number,
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
    return { ok: true, mode: "budget", timeoutMs: remaining };
  }
  return { ok: true, mode: "provider", timeoutMs: DEFAULT_LLM_CALL_TIMEOUT_MS };
};

const timeoutAbortResult = (
  timeout: LlmCallTimedOut,
  scope: string,
  runId: number,
  tokensUsed: number,
  traceContext?: TraceContext,
): Effect.Effect<SubmitResult, SqlError | JsonStringifyError, Ledger> => {
  if (timeout.mode === "budget") {
    return finalAbort(
      ABORT.BUDGET_TIME,
      { elapsedMs: timeout.elapsedMs, maxMs: timeout.timeoutMs },
      scope,
      runId,
      tokensUsed,
      traceContext,
    );
  }
  return finalAbort(
    ABORT.UPSTREAM_FAILURE,
    { cause: "provider_timeout", timeoutMs: timeout.timeoutMs },
    scope,
    runId,
    tokensUsed,
    traceContext,
  );
};

const isLlmCallTimedOut = (error: unknown): error is LlmCallTimedOut =>
  error instanceof LlmCallTimedOut;

export const submitAgentEffect = (
  spec: InternalSubmitSpec,
): Effect.Effect<
  SubmitResult,
  SqlError | JsonStringifyError | InvalidTraceContext | RefResolutionFailed,
  Ledger | LlmTransport | Quota | Admission
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const traceContextResult = validateOptionalTraceContext(spec.traceContext);
    if (!traceContextResult.ok) {
      return yield* Effect.fail(
        new InvalidTraceContext({
          position: "submit",
          reason: traceContextResult.reason,
        }),
      );
    }
    const traceContext = copyTraceContext(traceContextResult.traceContext);
    const startTime = yield* Clock.currentTimeMillis;
    const budgetTokens = spec.budget?.tokens ?? Number.POSITIVE_INFINITY;
    const budgetTimeMs = spec.budget?.timeMs ?? Number.POSITIVE_INFINITY;
    const maxTurns = spec.budget?.maxTurns ?? 5;
    const toolRetries = Math.max(0, spec.budget?.toolRetries ?? 2);
    const scope = spec.deliver.scope;
    const scopeRef = spec.deliver.scopeRef;

    const started = yield* logRuntimeLedgerEvent(
      ledger,
      agentRunStartedEvent({ scope, intent: spec.intent, traceContext }),
    );
    yield* logRuntimeLedgerEvent(
      ledger,
      chatIngestedEvent({
        scope,
        runId: started.id,
        intent: spec.intent,
        context: spec.context,
        traceContext,
      }),
    );

    const tokensUsedRef = yield* Ref.make(0);
    // ====================================================================
    // Spec-25 short path: structured-output submit (one-shot, no loop).
    //
    // outputSchema present → bypass the multi-turn tool loop entirely.
    // attemptStructured handles the admission gate (lease cache), provider
    // call, decode, and evidence emission. Submit owns token budget,
    // deliver, and terminal run facts.
    // ====================================================================
    if (spec.outputSchema !== undefined) {
      if (Object.keys(spec.tools).length > 0) {
        return yield* finalAbort(
          ABORT.UPSTREAM_FAILURE,
          {
            reason: "output_schema_excludes_tools_in_v0_2_10",
            toolCount: Object.keys(spec.tools).length,
          },
          scope,
          started.id,
          0,
          traceContext,
        );
      }

      const admission = yield* Admission;
      const schemaSpec = yield* makeAdmissionSchemaSpec(spec.outputSchema);
      const route: LlmRoute = spec.route;

      const ctxStr = yield* safeStringifyPretty(spec.context);
      const userText = `${spec.intent}\n\nContext:\n${ctxStr}`;
      const deliverEventName = spec.deliver.event;

      const beforeCall = yield* Clock.currentTimeMillis;
      const tokensBeforeCall = yield* Ref.get(tokensUsedRef);
      const timeout = llmTimeoutFor(startTime, beforeCall, budgetTimeMs);
      if (!timeout.ok) {
        return yield* finalAbort(
          ABORT.BUDGET_TIME,
          { elapsedMs: timeout.elapsedMs, maxMs: budgetTimeMs },
          scope,
          started.id,
          tokensBeforeCall,
          traceContext,
        );
      }
      const controller = new AbortController();
      const attempted = yield* Effect.either(
        admission
          .attemptStructured<unknown>({
            scope,
            route,
            schemaSpec,
            strategy: "forced-tool-call",
            traceContext,
            signal: controller.signal,
            stimulus: {
              kind: "live",
              userInput: { userText },
            },
          })
          .pipe(
            Effect.timeoutFail({
              duration: Duration.millis(timeout.timeoutMs),
              onTimeout: () => {
                controller.abort("agent_os.llm_call_timeout");
                return new LlmCallTimedOut({
                  mode: timeout.mode,
                  elapsedMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                  timeoutMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                });
              },
            }),
          ),
      );
      if (attempted._tag === "Left") {
        if (isLlmCallTimedOut(attempted.left)) {
          return yield* timeoutAbortResult(
            attempted.left,
            scope,
            started.id,
            tokensBeforeCall,
            traceContext,
          );
        }
        if (attempted.left._tag === ABORT.UPSTREAM_FAILURE) {
          return yield* finalAbort(
            ABORT.UPSTREAM_FAILURE,
            { cause: publicRuntimeCauseReason(attempted.left.cause) },
            scope,
            started.id,
            tokensBeforeCall,
            traceContext,
          );
        }
        return yield* Effect.fail(attempted.left);
      }
      const result = attempted.right;

      if (result.ok) {
        const tokens = result.outcome.class === "Supported" ? result.outcome.tokensUsed : 0;
        yield* Ref.set(tokensUsedRef, tokens);
        if (tokens > budgetTokens) {
          return yield* finalAbort(
            ABORT.BUDGET_TOKENS,
            { tokensUsed: tokens, tokensMax: budgetTokens },
            scope,
            started.id,
            tokens,
            traceContext,
          );
        }
        const finalStr = yield* safeStringify(result.decoded);
        yield* ledger.commit([
          { kind: deliverEventName, payload: result.decoded, scope },
          agentRunCompletedEvent({
            scope,
            runId: started.id,
            event: deliverEventName,
            traceContext,
          }),
        ]);
        const events = yield* ledger.events(scope);
        return {
          ok: true,
          runId: started.id,
          final: finalStr,
          eventCount: events.length,
          tokensUsed: tokens,
        } as const;
      }

      // attemptStructured returned a non-Supported outcome. Funnel
      // through finalAbort so the abort taxonomy stays stable (no new
      // ABORT kind for v0.2.10).
      return yield* finalAbort(
        ABORT.UPSTREAM_FAILURE,
        {
          reason: "structured_output_failed",
          outcomeClass: result.outcome.class,
          shortCircuited: result.shortCircuited,
          admissionImpact: result.admissionImpact,
          lease: result.lease,
        },
        scope,
        started.id,
        0,
        traceContext,
      );
    }

    // ====================================================================
    // Spec-24 standard path: multi-turn tool loop.
    // ====================================================================

    const registry = validateToolRegistry(spec.tools);
    if (!registry.ok) {
      return yield* finalAbort(
        ABORT.TOOL_ERROR,
        {
          reason: "invalid_tool_registry",
          issues: registry.issues,
        },
        scope,
        started.id,
        0,
        traceContext,
      );
    }

    const initialMessages = yield* buildInitialMessages(spec);

    const loop: Effect.Effect<
      SubmitResult,
      SqlError | JsonStringifyError | UpstreamFailure | ToolError | RefResolutionFailed,
      Ledger | LlmTransport | Quota
    > = Effect.gen(function* () {
      const messages: LlmMessage[] = [...initialMessages];
      const toolDefs = toolDefinitionsOf(spec.tools);
      const quotaService = yield* Quota;
      const llm = yield* LlmTransport;

      for (let turn = 0; turn < maxTurns; turn++) {
        const now = yield* Clock.currentTimeMillis;
        const tokensBeforeCall = yield* Ref.get(tokensUsedRef);

        const timeout = llmTimeoutFor(startTime, now, budgetTimeMs);
        if (!timeout.ok) {
          return yield* finalAbort(
            ABORT.BUDGET_TIME,
            { elapsedMs: timeout.elapsedMs, maxMs: budgetTimeMs },
            scope,
            started.id,
            tokensBeforeCall,
            traceContext,
          );
        }

        const controller = new AbortController();
        const timedResp = yield* Effect.either(
          llm
            .call(
              {
                route: spec.route,
                messages,
                tools: toolDefs.length > 0 ? toolDefs : undefined,
                traceContext,
              },
              { signal: controller.signal },
            )
            .pipe(
              Effect.timeoutFail({
                duration: Duration.millis(timeout.timeoutMs),
                onTimeout: () => {
                  controller.abort("agent_os.llm_call_timeout");
                  return new LlmCallTimedOut({
                    mode: timeout.mode,
                    elapsedMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                    timeoutMs: timeout.mode === "budget" ? budgetTimeMs : timeout.timeoutMs,
                  });
                },
              }),
            ),
        );
        if (timedResp._tag === "Left") {
          if (isLlmCallTimedOut(timedResp.left)) {
            return yield* timeoutAbortResult(
              timedResp.left,
              scope,
              started.id,
              tokensBeforeCall,
              traceContext,
            );
          }
          return yield* Effect.fail(timedResp.left);
        }
        const resp = timedResp.right;
        const responseText = textFromLlmOutputItems(resp.items);
        const responseToolCalls = toolCallsFromLlmOutputItems(resp.items);

        const newTokens = tokensBeforeCall + resp.usage.totalTokens;
        yield* Ref.set(tokensUsedRef, newTokens);

        yield* logRuntimeLedgerEvent(
          ledger,
          llmResponseEvent({
            scope,
            turn: turnRefOf(started.id, turn),
            items: resp.items,
            usage: resp.usage,
            traceContext,
          }),
        );

        if (newTokens > budgetTokens) {
          return yield* finalAbort(
            ABORT.BUDGET_TOKENS,
            { tokensUsed: newTokens, tokensMax: budgetTokens },
            scope,
            started.id,
            newTokens,
            traceContext,
          );
        }

        messages.push({
          role: "assistant",
          content: responseText,
          tool_calls: responseToolCalls.length > 0 ? responseToolCalls : undefined,
        });

        if (responseToolCalls.length === 0) {
          yield* ledger.commit([
            {
              kind: spec.deliver.event,
              payload: { final: responseText, turn: turnRefOf(started.id, turn) },
              scope,
            },
            agentRunCompletedEvent({
              scope,
              runId: started.id,
              event: spec.deliver.event,
              traceContext,
            }),
          ]);
          const events = yield* ledger.events(scope);
          return {
            ok: true,
            runId: started.id,
            final: responseText,
            eventCount: events.length,
            tokensUsed: newTokens,
          } as const;
        }

        for (const call of responseToolCalls) {
          // Parse OUTSIDE the retry block. unknown_tool / invalid_args are
          // non-recoverable: retrying the same args won't make them valid,
          // AND parsing before any quota grant means invalid LLM-emitted
          // args never consume quota.
          const parsed = yield* parseToolCall(spec.tools, call);
          const { tool } = parsed;
          const args = yield* decodeToolArgs(tool, parsed.args, call.function.name);
          const contract = tool.contract;
          // O-2: LLM-emitted tool arguments are not reproducible idempotency
          // material; this concrete call attempt is the semantic effect.
          const claim = makePreClaim({
            operationRef: makeOperationRef("tool", [scope, started.id, turn, call.id]),
            scopeRef,
            authorityRef: contract.authorityRef,
            originRef: contract.originRef ?? {
              originId: `run:${started.id}`,
              originKind: "submit",
            },
          });

          const admission = yield* Effect.tryPromise({
            try: () =>
              Promise.resolve(
                tool.admit({
                  claim,
                  args,
                  contract,
                  execution: tool.execution,
                  toolName: call.function.name,
                }),
              ),
            catch: (cause): RejectionRef => admitterErrorRejectionRef(claim, cause),
          }).pipe(
            Effect.catchAll((rejectionRef) =>
              Effect.succeed({
                ok: false as const,
                rejectionRef,
              }),
            ),
          );
          const normalizedAdmission = normalizeAdmitVerdict(claim, admission);
          const rejectedAdmission =
            normalizedAdmission.ok === false ? normalizedAdmission.rejectionRef : null;
          if (rejectedAdmission !== null) {
            yield* logRuntimeLedgerEvent(
              ledger,
              toolRejectedEvent({
                scope,
                runId: started.id,
                toolCallId: call.id,
                name: call.function.name,
                args: call.function.arguments,
                execution: tool.execution,
                claim: settleToolAdmissionRejected(claim, rejectedAdmission),
                traceContext,
              }),
            );
            return yield* new ToolError({
              toolName: call.function.name,
              cause: toolAdmissionFailureCause(rejectedAdmission),
            });
          }

          // Grant + execute are inside retry, but quota grants are keyed by
          // the semantic tool claim operationRef. Retrying the same claim
          // cannot double-charge quota; separate tool calls still consume
          // separate quota.
          const attemptOnce: Effect.Effect<unknown, ToolError | SqlError | JsonStringifyError> =
            Effect.gen(function* () {
              const attempt = Effect.gen(function* () {
                if (tool.quota !== undefined) {
                  const q = tool.quota;
                  const amount = q.amount ?? 1;
                  if (!Number.isFinite(amount) || amount < 0) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_amount", amount },
                    });
                  }
                  if (!Number.isFinite(q.limit) || q.limit < 0) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_limit", limit: q.limit },
                    });
                  }
                  // windowMs accepts POSITIVE_INFINITY (unbounded billing
                  // window) but not NaN or negative.
                  const windowOk =
                    q.windowMs === Number.POSITIVE_INFINITY ||
                    (Number.isFinite(q.windowMs) && q.windowMs >= 0);
                  if (!windowOk) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_window", windowMs: q.windowMs },
                    });
                  }
                  if (q.key !== undefined && q.key.length === 0) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: { reason: "invalid_quota_key", key: q.key },
                    });
                  }
                  const key = q.key ?? call.function.name;
                  const grant = yield* quotaService.tryGrant(
                    scope,
                    key,
                    amount,
                    q.windowMs,
                    q.limit,
                    call.function.name,
                    claim.operationRef,
                  );
                  if (!grant.granted) {
                    return yield* new ToolError({
                      toolName: call.function.name,
                      cause: {
                        reason: "rate_limited",
                        key,
                        consumed: grant.consumed,
                        limit: grant.limit,
                      },
                    });
                  }
                }
                return yield* executeTool(tool, args, call.function.name, traceContext);
              });
              if (!Number.isFinite(budgetTimeMs)) {
                return yield* attempt;
              }
              const now = yield* Clock.currentTimeMillis;
              const elapsedMs = now - startTime;
              const remainingMs = budgetTimeMs - elapsedMs;
              if (remainingMs <= 0) {
                return yield* new ToolError({
                  toolName: call.function.name,
                  cause: toolBudgetTimeCause(elapsedMs, budgetTimeMs),
                });
              }
              return yield* attempt.pipe(
                Effect.timeoutFail({
                  duration: Duration.millis(remainingMs),
                  onTimeout: () =>
                    new ToolError({
                      toolName: call.function.name,
                      cause: toolBudgetTimeCause(budgetTimeMs, budgetTimeMs),
                    }),
                }),
              );
            });

          const result = yield* attemptOnce.pipe(
            Effect.retry({
              times: toolRetries,
              while: (err) => {
                // Don't retry rate_limited — quota state doesn't change
                // between immediate retries.
                // Don't retry invalid_quota_* — config error, not transient.
                if (err._tag === ABORT.TOOL_ERROR) {
                  const cause = (err as ToolError).cause;
                  if (typeof cause === "object" && cause !== null) {
                    const reason = (cause as { reason?: unknown }).reason;
                    if (reason === "budget_time") return false;
                    if (reason === "rate_limited") return false;
                    if (typeof reason === "string" && reason.startsWith("invalid_quota_")) {
                      return false;
                    }
                  }
                }
                return true;
              },
            }),
            Effect.catchTags({
              [ABORT.TOOL_ERROR]: (error) =>
                Effect.gen(function* () {
                  const reason = toolErrorReason(error);
                  yield* logRuntimeLedgerEvent(
                    ledger,
                    toolRejectedEvent({
                      scope,
                      runId: started.id,
                      toolCallId: call.id,
                      name: call.function.name,
                      args: call.function.arguments,
                      execution: tool.execution,
                      claim: settleToolExecutionRejected(claim, reason),
                      traceContext,
                    }),
                  );
                  return yield* error;
                }),
            }),
          );

          const resultStr = yield* safeStringify(result);
          yield* logRuntimeLedgerEvent(
            ledger,
            toolExecutedEvent({
              scope,
              runId: started.id,
              toolCallId: call.id,
              name: call.function.name,
              args: call.function.arguments,
              execution: tool.execution,
              result,
              claim: settleToolExecuted(claim, contract),
              traceContext,
            }),
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.function.name,
            content: resultStr,
          });
        }
      }

      const tokensUsed = yield* Ref.get(tokensUsedRef);
      return yield* finalAbort(
        ABORT.RETRIES,
        { maxTurns },
        scope,
        started.id,
        tokensUsed,
        traceContext,
      );
    });

    return yield* loop.pipe(
      Effect.catchTags({
        [ABORT.UPSTREAM_FAILURE]: (e) =>
          Effect.gen(function* () {
            const tokensUsed = yield* Ref.get(tokensUsedRef);
            return yield* finalAbort(
              ABORT.UPSTREAM_FAILURE,
              { cause: publicRuntimeCauseReason(e.cause) },
              scope,
              started.id,
              tokensUsed,
              traceContext,
            );
          }),
        [ABORT.TOOL_ERROR]: (e) =>
          Effect.gen(function* () {
            const tokensUsed = yield* Ref.get(tokensUsedRef);
            if (isToolBudgetTimeError(e)) {
              return yield* finalAbort(
                ABORT.BUDGET_TIME,
                toolBudgetTimePayload(e),
                scope,
                started.id,
                tokensUsed,
                traceContext,
              );
            }
            return yield* finalAbort(
              ABORT.TOOL_ERROR,
              { toolName: e.toolName, cause: publicRuntimeCauseReason(e.cause) },
              scope,
              started.id,
              tokensUsed,
              traceContext,
            );
          }),
      }),
    );
  });
