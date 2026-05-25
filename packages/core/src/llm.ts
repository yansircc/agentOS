/**
 * LLM carrier — module-private wrapper around env.AI.run.
 *
 * Decodes the upstream response via effect/Schema; malformed responses
 * become UpstreamFailure (no silent fallback to text="").
 */

import { Context, Effect, Schema } from "effect";
import { UpstreamFailure } from "./errors";

export class AiBinding extends Context.Tag("@agent-os/AiBinding")<
  AiBinding,
  Ai
>() {}

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

export const callLlm = (
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
