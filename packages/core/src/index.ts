/**
 * @agent-os/core v0.1.1
 *
 * Effect-compliant agent substrate. Boundary translation to Promise at
 * AgentDOBase.submit / events.
 *
 * Changes vs v0.1 (Codex review fixes):
 *   FP-1 Termination is sacred:
 *     - all recoverable failures funnel through ledger BEFORE Promise boundary
 *     - only SqlError | JsonStringifyError escape (irrecoverable infra failures)
 *     - events() no longer silently masks SqlError as []
 *   FP-2 Budget semantics:
 *     - split into maxTurns (LLM loop cap) + toolRetries (per-tool retry)
 *     - token budget checked AFTER each LLM call (not just before)
 *     - tool dispatch retried via Effect.retry + Schedule.recurs
 *   FP-3 Failure vocabulary single source of truth:
 *     - ABORT const drives both Data.TaggedError tags AND ledger event kinds
 *     - SubmitResult.reason derived from kind (no string duplication)
 *   FP-1 derived:
 *     - LLM upstream response decoded via effect/Schema; malformed -> UpstreamFailure
 *     - all JSON.stringify wrapped via safeStringify with JsonStringifyError
 */

import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  ManagedRuntime,
  Ref,
  Schedule,
  Schema,
} from "effect";
import { DurableObject } from "cloudflare:workers";

// ============================================================
//          ABORT TAXONOMY (single source of truth — FP-3)
// ============================================================
// Each abort kind drives BOTH the ledger event name AND the TaggedError tag.
// SubmitResult.reason is mechanically derived: kind minus the "agent.aborted." prefix.

export const ABORT = {
  BUDGET_TOKENS: "agent.aborted.budget_tokens",
  BUDGET_TIME: "agent.aborted.budget_time",
  TOOL_ERROR: "agent.aborted.tool_error",
  UPSTREAM_FAILURE: "agent.aborted.upstream_failure",
  RETRIES: "agent.aborted.retries",
} as const;

export type AbortKind = (typeof ABORT)[keyof typeof ABORT];

const reasonOf = (kind: AbortKind): string =>
  kind.replace(/^agent\.aborted\./, "");

// ============================================================
//                     TAGGED ERRORS
// ============================================================
// Irrecoverable (escape the Promise boundary as rejection):
//   - SqlError            (ledger storage broken)
//   - JsonStringifyError  (cannot even serialize for ledger)
//
// Recoverable (caught inside submitAgentEffect, logged to ledger, converted
// to SubmitResult{ok:false}):
//   - UpstreamFailure
//   - ToolError

export class SqlError extends Data.TaggedError("agent_os.sql_error")<{
  readonly cause: unknown;
}> {}

export class JsonStringifyError extends Data.TaggedError(
  "agent_os.json_stringify_error",
)<{
  readonly cause: unknown;
}> {}

export class UpstreamFailure extends Data.TaggedError(
  ABORT.UPSTREAM_FAILURE,
)<{
  readonly cause: unknown;
}> {}

export class ToolError extends Data.TaggedError(ABORT.TOOL_ERROR)<{
  readonly toolName: string;
  readonly cause: unknown;
}> {}

// ============================================================
//                     JSON SAFE-STRINGIFY
// ============================================================

const safeStringify = (
  value: unknown,
): Effect.Effect<string, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => new JsonStringifyError({ cause }),
  });

const safeStringifyPretty = (
  value: unknown,
): Effect.Effect<string, JsonStringifyError> =>
  Effect.try({
    try: () => JSON.stringify(value, null, 2),
    catch: (cause) => new JsonStringifyError({ cause }),
  });

// ============================================================
//                     LEDGER PRIMITIVES
// ============================================================

export interface LedgerEvent {
  readonly id: number;
  readonly ts: number;
  readonly kind: string;
  readonly scope: string;
  readonly payload: unknown;
}

/** RPC-friendly variant of LedgerEvent (mutable + `payload: any`).
 *  Used as return type of AgentDOBase.events so DurableObjectStub typing
 *  stays inhabited under workers-types RpcSerializable constraints.
 */
export interface LedgerEventRpc {
  id: number;
  ts: number;
  kind: string;
  scope: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

export class Ledger extends Context.Tag("@agent-os/Ledger")<
  Ledger,
  {
    readonly log: (
      kind: string,
      payload: unknown,
      scope: string,
    ) => Effect.Effect<LedgerEvent, SqlError | JsonStringifyError>;
    readonly events: (
      scope: string,
    ) => Effect.Effect<ReadonlyArray<LedgerEvent>, SqlError>;
  }
>() {}

const ensureSchema = (sql: SqlStorage): Effect.Effect<void, SqlError> =>
  Effect.try({
    try: () =>
      sql.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL,
          scope TEXT NOT NULL,
          payload TEXT NOT NULL
        )
      `),
    catch: (cause) => new SqlError({ cause }),
  }).pipe(Effect.asVoid);

export const LedgerLive = (sql: SqlStorage): Layer.Layer<Ledger, SqlError> =>
  Layer.scoped(
    Ledger,
    Effect.gen(function* () {
      yield* ensureSchema(sql);

      return {
        log: (kind, payload, scope) =>
          Effect.gen(function* () {
            const ts = yield* Clock.currentTimeMillis;
            const payloadStr = yield* safeStringify(payload);
            const cursor = yield* Effect.try({
              try: () =>
                sql.exec(
                  "INSERT INTO events (ts, kind, scope, payload) VALUES (?, ?, ?, ?) RETURNING id",
                  ts,
                  kind,
                  scope,
                  payloadStr,
                ),
              catch: (cause) => new SqlError({ cause }),
            });
            const id = Number(cursor.one().id);
            return { id, ts, kind, scope, payload } satisfies LedgerEvent;
          }),
        events: (scope) =>
          Effect.try({
            try: () =>
              sql
                .exec(
                  "SELECT * FROM events WHERE scope = ? ORDER BY id",
                  scope,
                )
                .toArray()
                .map(
                  (r): LedgerEvent => ({
                    id: Number(r.id),
                    ts: Number(r.ts),
                    kind: String(r.kind),
                    scope: String(r.scope),
                    payload: JSON.parse(String(r.payload)) as unknown,
                  }),
                ),
            catch: (cause) => new SqlError({ cause }),
          }),
      };
    }),
  );

// ============================================================
//                     LLM CARRIER + SCHEMA
// ============================================================

export class AiBinding extends Context.Tag("@agent-os/AiBinding")<
  AiBinding,
  Ai
>() {}

// Schema for OpenAI Chat Completions response (used by CF env.AI.run).
// Malformed responses -> UpstreamFailure (no silent fallback to text="").

const LlmToolCallSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});

const LlmMessageOutputSchema = Schema.Struct({
  content: Schema.NullishOr(Schema.String),
  tool_calls: Schema.optional(Schema.Array(LlmToolCallSchema)),
});

const LlmChoiceSchema = Schema.Struct({
  message: LlmMessageOutputSchema,
});

const LlmUsageSchema = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
});

const LlmResponseSchema = Schema.Struct({
  choices: Schema.Array(LlmChoiceSchema),
  usage: Schema.optional(LlmUsageSchema),
});

export type LlmToolCall = Schema.Schema.Type<typeof LlmToolCallSchema>;

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<LlmToolCall>;
  readonly tool_call_id?: string;
}

export interface LlmResponse {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<LlmToolCall>;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: object;
  };
}

export interface LlmRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<LlmMessage>;
  readonly tools?: ReadonlyArray<ToolDefinition>;
}

const callLlm = (
  request: LlmRequest,
): Effect.Effect<LlmResponse, UpstreamFailure, AiBinding> =>
  Effect.gen(function* () {
    const ai = yield* AiBinding;
    const raw = yield* Effect.tryPromise({
      try: () =>
        (ai as { run: (m: string, p: unknown) => Promise<unknown> }).run(
          request.model,
          { messages: request.messages, tools: request.tools },
        ),
      catch: (cause) => new UpstreamFailure({ cause }),
    });

    const decoded = yield* Schema.decodeUnknown(LlmResponseSchema)(raw).pipe(
      Effect.mapError(
        (parseError) => new UpstreamFailure({ cause: parseError }),
      ),
    );

    const firstChoice = decoded.choices[0];
    if (firstChoice === undefined) {
      return yield* new UpstreamFailure({
        cause: "empty choices array in upstream response",
      });
    }

    const text = firstChoice.message.content ?? "";
    const toolCalls = firstChoice.message.tool_calls ?? [];
    const usage = {
      promptTokens: decoded.usage?.prompt_tokens ?? 0,
      completionTokens: decoded.usage?.completion_tokens ?? 0,
      totalTokens: decoded.usage?.total_tokens ?? 0,
    };
    return { text, toolCalls, usage } satisfies LlmResponse;
  });

// ============================================================
//                     TOOLS (public API)
// ============================================================

export interface Tool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  R = any,
> {
  readonly definition: ToolDefinition;
  readonly execute: (args: A) => Promise<R>;
}

const dispatchTool = (
  tools: Record<string, Tool>,
  call: LlmToolCall,
): Effect.Effect<unknown, ToolError> =>
  Effect.gen(function* () {
    const tool = tools[call.function.name];
    if (tool === undefined) {
      return yield* new ToolError({
        toolName: call.function.name,
        cause: { reason: "unknown_tool" },
      });
    }
    const args = yield* Effect.try({
      try: () => JSON.parse(call.function.arguments) as unknown,
      catch: (cause) =>
        new ToolError({ toolName: call.function.name, cause }),
    });
    return yield* Effect.tryPromise({
      try: () => tool.execute(args),
      catch: (cause) =>
        new ToolError({ toolName: call.function.name, cause }),
    });
  });

// ============================================================
//                     SUBMIT AGENT
// ============================================================

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

/** The SINGLE termination funnel. All aborts route through here.
 *  Only SqlError | JsonStringifyError escape (true infra failures).
 */
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
  spec: SubmitSpec,
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

        // FP-2: token budget check AFTER LLM call returns
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
          // Natural stop -> deliver
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

        // Dispatch tool calls with per-tool retry (FP-2)
        for (const call of resp.toolCalls) {
          const result = yield* dispatchTool(spec.tools, call).pipe(
            Effect.retry(Schedule.recurs(toolRetries)),
          );
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

      // Max turns exhausted -> RETRIES abort (a deliberate naming choice;
      // spec §7 lists "agent.aborted.retries" as the canonical kind for this).
      const tokensUsed = yield* Ref.get(tokensUsedRef);
      return yield* finalAbort(
        ABORT.RETRIES,
        { maxTurns },
        scope,
        ingest.id,
        tokensUsed,
      );
    });

    // FP-1: single termination funnel — catch recoverable failures and
    // funnel them through finalAbort (which logs the ledger event).
    // SqlError | JsonStringifyError remain and propagate to Promise reject.
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

// ============================================================
//                     RUNTIME + AgentDO BASE
// ============================================================

export interface AgentDOEnv {
  readonly AI: Ai;
}

type CoreServices = Ledger | AiBinding;

const makeAgentRuntime = (
  sql: SqlStorage,
  ai: Ai,
): ManagedRuntime.ManagedRuntime<CoreServices, SqlError> =>
  ManagedRuntime.make(
    Layer.merge(LedgerLive(sql), Layer.succeed(AiBinding, ai)),
  );

/**
 * AgentDO base class. Apps subclass this for RPC entry points.
 *
 * Boundary translation: each public method calls runtime.runPromise(eff)
 * once. Apps see plain Promise; never import Effect.
 *
 * Promise rejection contract:
 *   - rejects on SqlError | JsonStringifyError (infra failures — cannot
 *     even log to ledger)
 *   - resolves with SubmitResult{ok:false, reason} on all logical aborts
 *     (budget / tool / upstream / retries) — these are pre-logged in ledger
 */
export abstract class AgentDOBase<
  Env extends AgentDOEnv,
> extends DurableObject<Env> {
  private _runtime?: ManagedRuntime.ManagedRuntime<CoreServices, SqlError>;

  protected get runtime(): ManagedRuntime.ManagedRuntime<
    CoreServices,
    SqlError
  > {
    if (this._runtime === undefined) {
      this._runtime = makeAgentRuntime(this.ctx.storage.sql, this.env.AI);
    }
    return this._runtime;
  }

  /** Submit an agent run. Resolves with SubmitResult; rejects only on infra. */
  submit(spec: SubmitSpec): Promise<SubmitResult> {
    return this.runtime.runPromise(submitAgentEffect(spec));
  }

  /** Query the ledger for a given scope.
   *  Rejects on SqlError — caller distinguishes empty-ledger from read failure.
   */
  events(scope: string): Promise<LedgerEventRpc[]> {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const ledger = yield* Ledger;
        const rows = yield* ledger.events(scope);
        return rows.map(
          (e): LedgerEventRpc => ({
            id: e.id,
            ts: e.ts,
            kind: e.kind,
            scope: e.scope,
            payload: e.payload,
          }),
        );
      }),
    );
  }
}
