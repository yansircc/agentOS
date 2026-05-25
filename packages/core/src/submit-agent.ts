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

import { Clock, Context, Effect, Ref, Schedule } from "effect";
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
import { AiBinding, callLlm, type LlmMessage, type ToolDefinition } from "./llm";
import { Ledger } from "./ledger";
import { dispatchTool, type Tool } from "./tools";

export interface SubmitSpec {
  readonly intent: string;
  readonly context: Record<string, unknown>;
  readonly agent: { readonly provider: string; readonly model: string };
  readonly tools: Record<string, Tool>;
  readonly budget?: {
    readonly tokens?: number;
    readonly timeMs?: number;
    /** LLM loop iteration cap. Hitting this -> RETRIES abort. Default 5. */
    readonly maxTurns?: number;
    /** Per-tool retry attempts (total = retries + 1). Default 2 (so 3 attempts). */
    readonly toolRetries?: number;
  };
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

const toolDefinitionsOf = (
  tools: Record<string, Tool>,
): ReadonlyArray<ToolDefinition> =>
  Object.values(tools).map((t) => t.definition);

/** Sum dispatch.consumed events for a {key} within window. v0 simple scan. */
const sumConsumed = (
  ledger: Context.Tag.Service<typeof Ledger>,
  scope: string,
  key: string,
  windowStartMs: number,
): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    const events = yield* ledger.events(scope);
    let sum = 0;
    for (const e of events) {
      if (e.kind !== "dispatch.consumed") continue;
      if (e.ts < windowStartMs) continue;
      const p = e.payload as
        | { key?: string; measure?: number }
        | null
        | undefined;
      if (p && p.key === key) {
        sum += Number(p.measure ?? 0);
      }
    }
    return sum;
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
    yield* ledger.log(kind, payload, scope);
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
  SqlError | JsonStringifyError,
  Ledger | AiBinding
> =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const startTime = yield* Clock.currentTimeMillis;
    const budgetTokens = spec.budget?.tokens ?? Number.POSITIVE_INFINITY;
    const budgetTimeMs = spec.budget?.timeMs ?? Number.POSITIVE_INFINITY;
    const maxTurns = spec.budget?.maxTurns ?? 5;
    const toolRetries = Math.max(0, spec.budget?.toolRetries ?? 2);
    const scope = spec.deliver.scope;

    const ingest = yield* ledger.log(
      "chat.ingested",
      { intent: spec.intent, context: spec.context },
      scope,
    );

    const tokensUsedRef = yield* Ref.make(0);

    const ctxStr = yield* safeStringifyPretty(spec.context);
    const initialMessages: LlmMessage[] = [
      {
        role: "system",
        content: `You are an agent. Goal: ${spec.intent}\n\nContext available:\n${ctxStr}\n\nUse the provided tools when needed. Reply with a final natural-language answer when you have enough information.`,
      },
      { role: "user", content: spec.intent },
    ];

    const loop: Effect.Effect<
      SubmitResult,
      | SqlError
      | JsonStringifyError
      | UpstreamFailure
      | ToolError,
      Ledger | AiBinding
    > = Effect.gen(function* () {
      const messages: LlmMessage[] = [...initialMessages];
      const toolDefs = toolDefinitionsOf(spec.tools);

      for (let turn = 0; turn < maxTurns; turn++) {
        const now = yield* Clock.currentTimeMillis;
        const tokensBeforeCall = yield* Ref.get(tokensUsedRef);

        if (now - startTime > budgetTimeMs) {
          return yield* finalAbort(
            ABORT.BUDGET_TIME,
            { elapsedMs: now - startTime, maxMs: budgetTimeMs },
            scope,
            ingest.id,
            tokensBeforeCall,
          );
        }

        const resp = yield* callLlm({
          model: `${spec.agent.provider}/${spec.agent.model}`,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });

        const newTokens = tokensBeforeCall + resp.usage.totalTokens;
        yield* Ref.set(tokensUsedRef, newTokens);

        yield* ledger.log(
          "llm.response",
          {
            turn,
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
            ingest.id,
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
            { final: resp.text },
            scope,
          );
          const events = yield* ledger.events(scope);
          return {
            ok: true,
            runId: ingest.id,
            final: resp.text,
            eventCount: events.length,
            tokensUsed: newTokens,
          } as const;
        }

        for (const call of resp.toolCalls) {
          const tool = spec.tools[call.function.name];
          // ── Quota pre-check ─────────────────────────────────────
          if (tool !== undefined && tool.quota !== undefined) {
            const quota = tool.quota;
            const key = quota.key ?? call.function.name;
            const nowQ = yield* Clock.currentTimeMillis;
            const windowStart =
              quota.windowMs === Number.POSITIVE_INFINITY
                ? 0
                : nowQ - quota.windowMs;
            const consumed = yield* sumConsumed(ledger, scope, key, windowStart);
            if (consumed >= quota.limit) {
              yield* ledger.log(
                "dispatch.rate_limited",
                {
                  key,
                  consumed,
                  limit: quota.limit,
                  windowMs: quota.windowMs,
                  toolName: call.function.name,
                },
                scope,
              );
              return yield* new ToolError({
                toolName: call.function.name,
                cause: {
                  reason: "rate_limited",
                  key,
                  consumed,
                  limit: quota.limit,
                },
              });
            }
          }

          const result = yield* dispatchTool(spec.tools, call).pipe(
            Effect.retry(Schedule.recurs(toolRetries)),
          );

          // ── Quota post-consume ──────────────────────────────────
          if (tool !== undefined && tool.quota !== undefined) {
            const quota = tool.quota;
            const key = quota.key ?? call.function.name;
            const measure = quota.measure
              ? quota.measure(result)
              : 1;
            yield* ledger.log(
              "dispatch.consumed",
              { key, measure, toolName: call.function.name },
              scope,
            );
          }

          const resultStr = yield* safeStringify(result);
          yield* ledger.log(
            "tool.executed",
            {
              name: call.function.name,
              args: call.function.arguments,
              result,
            },
            scope,
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: resultStr,
          });
        }
      }

      const tokensUsed = yield* Ref.get(tokensUsedRef);
      return yield* finalAbort(
        ABORT.RETRIES,
        { maxTurns },
        scope,
        ingest.id,
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
              ingest.id,
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
              ingest.id,
              tokensUsed,
            );
          }),
      }),
    );
  });
