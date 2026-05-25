/**
 * Spike 04 — structured-submit finalizer model matrix.
 *
 * This validates the future agentOS `submitStructured` shape without touching
 * core. A row is promotable only when the tuple
 * `(model, strategy, schemaId)` returns the expected carrier and the
 * arguments decode through the owned Effect Schema.
 */

import { Data, Effect, JSONSchema, Schema } from "effect";

interface Env {
  AI: Ai;
}

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const STRUCTURED_TOOL = "submit_image_plan";
const SCHEMA_ID = "ImgGenPlan.v1";
const DEFAULT_STRATEGY = "json-schema";
const OPENAI_FORCED_MAX_TOKENS = 1024;
const CF_NATIVE_MAX_TOKENS = 1024;
const JSON_SCHEMA_MAX_TOKENS = 1024;

const JSON_MODE_MODELS = [
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
] as const;

const FUNCTION_CALLING_MODELS = [
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/nvidia/nemotron-3-120b-a12b",
] as const;

const CATALOG_TEXT_MODELS = [
  ...JSON_MODE_MODELS,
  ...FUNCTION_CALLING_MODELS.filter(
    (model) => !JSON_MODE_MODELS.includes(model as never),
  ),
  "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
  "@cf/qwen/qwq-32b",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
  "@cf/meta/llama-guard-3-8b",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/google/gemma-7b-it-lora",
  "@cf/google/gemma-2b-it-lora",
  "@cf/meta-llama/llama-2-7b-chat-hf-lora",
  "@cf/mistral/mistral-7b-instruct-v0.2-lora",
] as const;

const EXCLUDED_VISION_TEXT_MODELS = [
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
] as const;

const CANDIDATE_MODELS = CATALOG_TEXT_MODELS;

const STRATEGIES = [
  "json-schema",
  "openai-forced",
  "cf-native-prompted",
] as const;

type Strategy = (typeof STRATEGIES)[number];

const ImageSpecSchema = Schema.Struct({
  prompt: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});

const PlanSchema = Schema.Struct({
  images: Schema.Array(ImageSpecSchema).pipe(Schema.minItems(1)),
});

type Plan = Schema.Schema.Type<typeof PlanSchema>;

const toToolParameters = (schema: Schema.Schema.Any): object => {
  const root = JSONSchema.make(schema) as unknown as Record<string, unknown>;
  const { $schema: _schema, ...parameters } = root;
  return parameters;
};

const PLAN_JSON_SCHEMA = toToolParameters(PlanSchema);

const LlmToolCallSchema = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});

const LlmResponseSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.NullishOr(Schema.String),
        tool_calls: Schema.optional(Schema.Array(LlmToolCallSchema)),
      }),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Schema.optional(Schema.Number),
      completion_tokens: Schema.optional(Schema.Number),
      total_tokens: Schema.optional(Schema.Number),
    }),
  ),
});

const NativeToolCallSchema = Schema.Struct({
  name: Schema.String,
  arguments: Schema.Unknown,
});

const NativeResponseSchema = Schema.Struct({
  response: Schema.optional(Schema.Unknown),
  tool_calls: Schema.optional(Schema.Array(NativeToolCallSchema)),
});

const AiResponseSchema = Schema.Union(LlmResponseSchema, NativeResponseSchema);

class UnsupportedStructuredOutputModel extends Data.TaggedError(
  "UnsupportedStructuredOutputModel",
)<{
  readonly model: string;
}> {}

class UnsupportedStructuredOutputStrategy extends Data.TaggedError(
  "UnsupportedStructuredOutputStrategy",
)<{
  readonly strategy: string;
}> {}

class UpstreamError extends Data.TaggedError("UpstreamError")<{
  readonly cause: unknown;
}> {}

class ResponseDecodeError extends Data.TaggedError("ResponseDecodeError")<{
  readonly cause: unknown;
}> {}

class StructuredOutputFailure extends Data.TaggedError(
  "StructuredOutputFailure",
)<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

type SpikeError =
  | UnsupportedStructuredOutputModel
  | UnsupportedStructuredOutputStrategy
  | UpstreamError
  | ResponseDecodeError
  | StructuredOutputFailure;

interface PlanRequest {
  readonly model?: string;
  readonly prompt?: string;
  readonly allowContentFallback?: boolean;
  readonly strategy?: string;
}

interface SuccessResult {
  readonly ok: true;
  readonly model: string;
  readonly strategy: Strategy;
  readonly schemaId: typeof SCHEMA_ID;
  readonly source: "tool_call" | "json_response" | "content";
  readonly toolName: string | null;
  readonly output: Plan;
  readonly usage: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
  readonly rawText: string | null;
}

interface FailureResult {
  readonly ok: false;
  readonly error: string;
  readonly detail: unknown;
}

const isSupportedModel = (model: string): boolean =>
  CANDIDATE_MODELS.includes(model as (typeof CANDIDATE_MODELS)[number]);

const isSupportedStrategy = (strategy: string): strategy is Strategy =>
  STRATEGIES.includes(strategy as Strategy);

const promptOf = (body: PlanRequest): string =>
  body.prompt ??
  [
    "Create an image generation plan for a compact agentOS architecture diagram.",
    "Return two image variants: one clean technical diagram and one product screenshot style mockup.",
    "Use 1024 by 1024 dimensions for both variants.",
  ].join(" ");

const makePayload = (strategy: Strategy, prompt: string): object => {
  const messages = [
    {
      role: "system",
      content:
        "You are an image planning finalizer. Call the provided structured submit tool. Do not answer with free text.",
    },
    {
      role: "user",
      content: prompt,
    },
  ];

  switch (strategy) {
    case "json-schema":
      return {
        messages,
        max_tokens: JSON_SCHEMA_MAX_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: PLAN_JSON_SCHEMA,
        },
      };
    case "openai-forced":
      return {
        messages,
        max_tokens: OPENAI_FORCED_MAX_TOKENS,
        tools: [
          {
            type: "function",
            function: {
              name: STRUCTURED_TOOL,
              description:
                "Submit the final image generation plan. The arguments are the whole plan.",
              parameters: PLAN_JSON_SCHEMA,
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: STRUCTURED_TOOL },
        },
      };
    case "cf-native-prompted":
      return {
        messages,
        max_tokens: CF_NATIVE_MAX_TOKENS,
        tools: [
          {
            name: STRUCTURED_TOOL,
            description:
              "Submit the final image generation plan. The arguments are the whole plan.",
            parameters: PLAN_JSON_SCHEMA,
          },
        ],
      };
  }
};

const parseJsonText = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) =>
      new StructuredOutputFailure({
        reason: "invalid_json_content",
        cause,
      }),
  });

const decodePlan = (input: unknown) =>
  Schema.decodeUnknown(PlanSchema)(input).pipe(
    Effect.mapError(
      (cause) =>
        new StructuredOutputFailure({
          reason: "schema_decode_failed",
          cause,
        }),
    ),
  );

const runStructuredPlan = (
  env: Env,
  body: PlanRequest,
): Effect.Effect<SuccessResult, SpikeError> =>
  Effect.gen(function* () {
    const model = body.model ?? DEFAULT_MODEL;
    const strategy = body.strategy ?? DEFAULT_STRATEGY;
    if (!isSupportedModel(model)) {
      return yield* new UnsupportedStructuredOutputModel({ model });
    }
    if (!isSupportedStrategy(strategy)) {
      return yield* new UnsupportedStructuredOutputStrategy({ strategy });
    }

    const raw = yield* Effect.tryPromise({
      try: () =>
        (env.AI as { run: (model: string, payload: unknown) => Promise<unknown> })
          .run(model, makePayload(strategy, promptOf(body))),
      catch: (cause) => new UpstreamError({ cause }),
    });

    const decoded = yield* Schema.decodeUnknown(AiResponseSchema)(raw).pipe(
      Effect.mapError((cause) => new ResponseDecodeError({ cause })),
    );

    const toolCall =
      "choices" in decoded
        ? decoded.choices[0]?.message.tool_calls?.[0]
        : decoded.tool_calls?.[0];
    const rawText =
      "choices" in decoded
        ? decoded.choices[0]?.message.content ?? null
        : typeof decoded.response === "string"
          ? decoded.response
          : decoded.response === undefined
            ? null
            : JSON.stringify(decoded.response);
    const nativeResponse =
      "choices" in decoded || decoded.response === undefined
        ? null
        : decoded.response;
    const toolName =
      toolCall === undefined
        ? null
        : "function" in toolCall
          ? toolCall.function.name
          : toolCall.name;
    const toolArguments =
      toolCall === undefined
        ? null
        : "function" in toolCall
          ? toolCall.function.arguments
          : toolCall.arguments;

    if (strategy === "json-schema") {
      const parsed =
        nativeResponse !== null && typeof nativeResponse !== "string"
          ? nativeResponse
          : yield* parseJsonText(
              typeof nativeResponse === "string"
                ? nativeResponse
                : rawText ?? "null",
            );
      const output = yield* decodePlan(parsed);
      return {
        ok: true,
        model,
        strategy,
        schemaId: SCHEMA_ID,
        source: "json_response",
        toolName: null,
        output,
        usage: {
          prompt: "usage" in decoded ? decoded.usage?.prompt_tokens ?? 0 : 0,
          completion:
            "usage" in decoded ? decoded.usage?.completion_tokens ?? 0 : 0,
          total: "usage" in decoded ? decoded.usage?.total_tokens ?? 0 : 0,
        },
        rawText,
      } satisfies SuccessResult;
    }

    if (toolCall === undefined || toolName === null || toolArguments === null) {
      if (body.allowContentFallback === true && rawText !== null) {
        const parsedText = yield* parseJsonText(rawText);
        const output = yield* decodePlan(parsedText);
        return {
          ok: true,
          model,
          strategy,
          schemaId: SCHEMA_ID,
          source: "content",
          toolName: null,
          output,
          usage: {
            prompt: "usage" in decoded ? decoded.usage?.prompt_tokens ?? 0 : 0,
            completion:
              "usage" in decoded ? decoded.usage?.completion_tokens ?? 0 : 0,
            total: "usage" in decoded ? decoded.usage?.total_tokens ?? 0 : 0,
          },
          rawText,
        } satisfies SuccessResult;
      }
      return yield* new StructuredOutputFailure({
        reason: "missing_tool_call",
        cause: { content: rawText },
      });
    }
    if (toolName !== STRUCTURED_TOOL) {
      return yield* new StructuredOutputFailure({
        reason: "wrong_tool_name",
        cause: { name: toolName },
      });
    }

    const parsed =
      typeof toolArguments === "string"
        ? yield* Effect.try({
            try: () => JSON.parse(toolArguments) as unknown,
            catch: (cause) =>
              new StructuredOutputFailure({
                reason: "invalid_json_arguments",
                cause,
              }),
          })
        : toolArguments;

    const output = yield* decodePlan(parsed);

    return {
      ok: true,
      model,
      strategy,
      schemaId: SCHEMA_ID,
      source: "tool_call",
      toolName,
      output,
      usage: {
        prompt: "usage" in decoded ? decoded.usage?.prompt_tokens ?? 0 : 0,
        completion:
          "usage" in decoded ? decoded.usage?.completion_tokens ?? 0 : 0,
        total: "usage" in decoded ? decoded.usage?.total_tokens ?? 0 : 0,
      },
      rawText,
    } satisfies SuccessResult;
  });

const runAsJson = (effect: Effect.Effect<SuccessResult, SpikeError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): FailureResult => ({
          ok: false,
          error: error._tag,
          detail:
            error._tag === "StructuredOutputFailure"
              ? {
                  reason: error.reason,
                  cause: error.cause,
                }
              : error._tag === "UpstreamError"
                ? { cause: String(error.cause) }
              : { ...error },
        }),
        onSuccess: (value) => value,
      }),
    ),
  );

const readPlanRequest = (req: Request): Promise<PlanRequest> =>
  req
    .json<PlanRequest>()
    .catch(() => ({}));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/plan") {
      return readPlanRequest(req)
        .then((body) => runAsJson(runStructuredPlan(env, body)))
        .then((result) => {
          const status =
            !result.ok &&
            (result.error === "UnsupportedStructuredOutputModel" ||
              result.error === "UnsupportedStructuredOutputStrategy")
              ? 400
              : 200;
          return Response.json(result, { status });
        });
    }

    if (req.method === "GET" && url.pathname === "/models") {
      return Response.json({
        defaultModel: DEFAULT_MODEL,
        defaultStrategy: DEFAULT_STRATEGY,
        schemaId: SCHEMA_ID,
        officialJsonModeModels: JSON_MODE_MODELS,
        functionCallingModels: FUNCTION_CALLING_MODELS,
        catalogTextModels: CATALOG_TEXT_MODELS,
        excludedVisionTextModels: EXCLUDED_VISION_TEXT_MODELS,
        candidates: CANDIDATE_MODELS,
        strategies: STRATEGIES,
        schema: "ImgGen PlanSchema",
        tool: STRUCTURED_TOOL,
      });
    }

    return new Response(
      [
        "agent-os spike-04 (structured-submit model matrix)",
        "",
        "GET  /models",
        "POST /plan { model?, strategy?, prompt?, allowContentFallback? }",
        "",
        `default model: ${DEFAULT_MODEL}`,
        `default strategy: ${DEFAULT_STRATEGY}`,
        `structured tool: ${STRUCTURED_TOOL}`,
      ].join("\n"),
      { headers: { "content-type": "text/plain" } },
    );
  },
} satisfies ExportedHandler<Env>;
