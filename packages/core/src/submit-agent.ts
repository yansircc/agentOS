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
 * submitAgentEffect is module-private. Apps call AgentDOBase.submit(spec)
 * which injects scope from ctx.id.name (SSoT) and runs this effect.
 */

import { Clock, Effect, Ref } from "effect";
import {
  ABORT,
  type AbortKind,
  JsonStringifyError,
  reasonOf,
  safeStringify,
  safeStringifyPretty,
  SqlError,
  ToolError,
  UpstreamFailure,
} from "./errors";
import {
  AiBinding,
  callLlm,
  type LlmMessage,
  type LlmRoute,
  type ToolDefinition,
} from "./llm";
import { Ledger } from "./ledger";
import { RefResolutionFailed, RefResolverService } from "./ref-resolver";
import { Quota } from "./quota";
import { executeTool, parseToolCall, type Tool } from "./tools";
import {
  Admission,
  type JsonSchemaObject,
  makeSchemaContract,
} from "./admission";

export interface SubmitSpec {
  /** Task input — what this specific invocation is for. Becomes the
   *  user message. Short, runtime-varying. */
  readonly intent: string;
  /** Runtime facts the agent needs for THIS invocation. Stringified into
   *  the system message under "Context available:". Variable axis. */
  readonly context: Record<string, unknown>;
  /** Behavior program — who the agent is, how it operates, what rules
   *  govern it. When provided, becomes the system message verbatim
   *  (with the Context block appended). When absent, the substrate
   *  generates a generic system from intent. Stable axis.
   *
   *  The three axes are intentionally distinct (see spec-24 §5.1.1):
   *    system  = behavior program (stable)
   *    intent  = task input       (variable)
   *    context = facts            (variable) */
  readonly system?: string;
  /** LLM transport route. Tagged union over protocol kinds (spec-25 §3,
   *  spec-24 INV-8 revision). Replaces the v0.2.11 `agent: {provider,
   *  model}` shape, which assumed a single cf-ai-binding transport.
   *  Apps choose their route per submit; capability is evidence on
   *  (route, schemaContract, strategy, adapterVersion), not on modelId. */
  readonly route: LlmRoute;
  readonly tools: Record<string, Tool>;
  readonly budget?: {
    readonly tokens?: number;
    readonly timeMs?: number;
    /** LLM loop iteration cap. Hitting this -> RETRIES abort. Default 5. */
    readonly maxTurns?: number;
    /** Per-tool retry attempts (total = retries + 1). Default 2 (so 3 attempts). */
    readonly toolRetries?: number;
  };
  /** Spec-25: optional structured output schema. When present, the agent
   *  loop is bypassed; a single `attemptStructured` call is made under the
   *  evidence-derived admission lease. The decoded output is written via
   *  the deliver event payload atomically with the evidence row. In
   *  v0.2.10, `outputSchema` and a non-empty `tools` are mutually
   *  exclusive (one-shot structured output, no tool-using turns). */
  readonly outputSchema?: JsonSchemaObject;
  /** Only the event name. Scope is structurally owned by the DO instance. */
  readonly deliver: { readonly event: string };
}

/** Internal SubmitSpec with scope filled in by AgentDOBase. */
export interface InternalSubmitSpec extends Omit<SubmitSpec, "deliver"> {
  readonly deliver: { readonly scope: string; readonly event: string };
}

export type SubmitResult =
  | {
      readonly ok: true;
      readonly runId: number;
      readonly final: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    }
  | {
      readonly ok: false;
      readonly runId: number;
      readonly reason: string;
      readonly eventCount: number;
      readonly tokensUsed: number;
    };

export interface TurnRef {
  readonly id: number;
  readonly index: number;
}

export const turnRefOf = (runId: number, index: number): TurnRef => ({
  id: runId,
  index,
});

const toolDefinitionsOf = (
  tools: Record<string, Tool>,
): ReadonlyArray<ToolDefinition> =>
  Object.values(tools).map((t) => t.definition);

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

/** The single termination funnel. All recoverable aborts route through here.
 *  Logs an agent.aborted.* ledger event then constructs SubmitResult.fail. */
const finalAbort = (
  kind: AbortKind,
  payload: object,
  scope: string,
  runId: number,
  tokensUsed: number,
): Effect.Effect<
  SubmitResult,
  SqlError | JsonStringifyError,
  Ledger
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    yield* ledger.log(kind, { runId, ...payload }, scope);
    const events = yield* ledger.events(scope);
    return {
      ok: false,
      runId,
      reason: reasonOf(kind),
      eventCount: events.length,
      tokensUsed,
    } as const;
  });

export const submitAgentEffect = (
  spec: InternalSubmitSpec,
): Effect.Effect<
  SubmitResult,
  SqlError | JsonStringifyError | RefResolutionFailed,
  Ledger | AiBinding | Quota | Admission | RefResolverService
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const startTime = yield* Clock.currentTimeMillis;
    const budgetTokens = spec.budget?.tokens ?? Number.POSITIVE_INFINITY;
    const budgetTimeMs = spec.budget?.timeMs ?? Number.POSITIVE_INFINITY;
    const maxTurns = spec.budget?.maxTurns ?? 5;
    const toolRetries = Math.max(0, spec.budget?.toolRetries ?? 2);
    const scope = spec.deliver.scope;

    const started = yield* ledger.log(
      "agent.run.started",
      { intent: spec.intent },
      scope,
    );
    yield* ledger.log(
      "chat.ingested",
      { runId: started.id, intent: spec.intent, context: spec.context },
      scope,
    );

    const tokensUsedRef = yield* Ref.make(0);

    // ====================================================================
    // Spec-25 short path: structured-output submit (one-shot, no loop).
    //
    // outputSchema present → bypass the multi-turn tool loop entirely.
    // attemptStructured handles the admission gate (lease cache), provider
    // call, decode, evidence emission, and deliver event in one
    // transactionSync. v0.2.10 requires tools to be empty when
    // outputSchema is supplied; mixing the two is deferred until a real
    // app needs it.
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
        );
      }

      const admission = yield* Admission;
      const schemaContract = yield* makeSchemaContract(spec.outputSchema);
      const route: LlmRoute = spec.route;

      const ctxStr = yield* safeStringifyPretty(spec.context);
      const userText = `${spec.intent}\n\nContext:\n${ctxStr}`;
      const deliverEventName = spec.deliver.event;

      const result = yield* admission.attemptStructured<unknown>({
        scope,
        route,
        schemaContract,
        strategy: "forced-tool-call",
        stimulus: {
          kind: "live",
          userInput: { userText },
          deliver: (decoded) => ({
            event: deliverEventName,
            payload: decoded,
          }),
        },
      });

      if (result.ok) {
        const tokens =
          result.outcome.class === "Supported"
            ? result.outcome.tokensUsed
            : 0;
        yield* Ref.set(tokensUsedRef, tokens);
        const finalStr = yield* safeStringify(result.decoded);
        yield* ledger.log(
          "agent.run.completed",
          { runId: started.id, event: deliverEventName },
          scope,
        );
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
      );
    }

    // ====================================================================
    // Spec-24 standard path: multi-turn tool loop.
    // ====================================================================

    const initialMessages = yield* buildInitialMessages(spec);

    const loop: Effect.Effect<
      SubmitResult,
      | SqlError
      | JsonStringifyError
      | UpstreamFailure
      | ToolError
      | RefResolutionFailed,
      Ledger | AiBinding | Quota | RefResolverService
    > = Effect.gen(function* () {
      const messages: LlmMessage[] = [...initialMessages];
      const toolDefs = toolDefinitionsOf(spec.tools);
      const quotaService = yield* Quota;

      for (let turn = 0; turn < maxTurns; turn++) {
        const now = yield* Clock.currentTimeMillis;
        const tokensBeforeCall = yield* Ref.get(tokensUsedRef);

        if (now - startTime > budgetTimeMs) {
          return yield* finalAbort(
            ABORT.BUDGET_TIME,
            { elapsedMs: now - startTime, maxMs: budgetTimeMs },
            scope,
            started.id,
            tokensBeforeCall,
          );
        }

        const resp = yield* callLlm({
          route: spec.route,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });

        const newTokens = tokensBeforeCall + resp.usage.totalTokens;
        yield* Ref.set(tokensUsedRef, newTokens);

        yield* ledger.log(
          "llm.response",
          {
            turn: turnRefOf(started.id, turn),
            text: resp.text,
            toolCalls: resp.toolCalls,
            usage: resp.usage,
          },
          scope,
        );

        if (newTokens > budgetTokens) {
          return yield* finalAbort(
            ABORT.BUDGET_TOKENS,
            { tokensUsed: newTokens, tokensMax: budgetTokens },
            scope,
            started.id,
            newTokens,
          );
        }

        messages.push({
          role: "assistant",
          content: resp.text,
          tool_calls:
            resp.toolCalls.length > 0 ? resp.toolCalls : undefined,
        });

        if (resp.toolCalls.length === 0) {
          yield* ledger.log(
            spec.deliver.event,
            { final: resp.text, turn: turnRefOf(started.id, turn) },
            scope,
          );
          yield* ledger.log(
            "agent.run.completed",
            { runId: started.id, event: spec.deliver.event },
            scope,
          );
          const events = yield* ledger.events(scope);
          return {
            ok: true,
            runId: started.id,
            final: resp.text,
            eventCount: events.length,
            tokensUsed: newTokens,
          } as const;
        }

        for (const call of resp.toolCalls) {
          // Parse OUTSIDE the retry block. unknown_tool / invalid_args are
          // non-recoverable: retrying the same args won't make them valid,
          // AND parsing before any quota grant means invalid LLM-emitted
          // args never consume quota.
          const parsed = yield* parseToolCall(spec.tools, call);
          const { tool, args } = parsed;

          // Per-attempt grant + execute (inside Effect.retry).
          // Each retry independently grants → retries count toward quota.
          const attemptOnce: Effect.Effect<
            unknown,
            ToolError | SqlError | JsonStringifyError
          > = Effect.gen(function* () {
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
            return yield* executeTool(tool, args, call.function.name);
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
                    if (reason === "rate_limited") return false;
                    if (
                      typeof reason === "string" &&
                      reason.startsWith("invalid_quota_")
                    ) {
                      return false;
                    }
                  }
                }
                return true;
              },
            }),
          );

          const resultStr = yield* safeStringify(result);
          yield* ledger.log(
            "tool.executed",
            {
              runId: started.id,
              name: call.function.name,
              args: call.function.arguments,
              result,
            },
            scope,
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
      );
    });

    return yield* loop.pipe(
      Effect.catchTags({
        [ABORT.UPSTREAM_FAILURE]: (e) =>
          Effect.gen(function* () {
            const tokensUsed = yield* Ref.get(tokensUsedRef);
            return yield* finalAbort(
              ABORT.UPSTREAM_FAILURE,
              { cause: String(e.cause) },
              scope,
              started.id,
              tokensUsed,
            );
          }),
        [ABORT.TOOL_ERROR]: (e) =>
          Effect.gen(function* () {
            const tokensUsed = yield* Ref.get(tokensUsedRef);
            return yield* finalAbort(
              ABORT.TOOL_ERROR,
              { toolName: e.toolName, cause: String(e.cause) },
              scope,
              started.id,
              tokensUsed,
            );
          }),
      }),
    );
  });
