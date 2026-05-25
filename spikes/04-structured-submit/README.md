# Spike 04: Structured-submit model matrix

## Invariant

Structured output is not accepted because a model returned JSON-like text or
because a provider page says the model supports JSON Mode. It is accepted only
when a specific `(model, strategy, schemaId)` tuple returns the expected
carrier and the payload decodes through the owned Effect Schema.

## Scope

This spike validates the candidate v0.2.10 implementation path without changing
`@agent-os/core`.

The first schema is Img-Gen-shaped:

```ts
Schema.Struct({
  images: Schema.Array(
    Schema.Struct({
      prompt: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ).pipe(Schema.minItems(1)),
})
```

## Strategies

| Strategy | Request shape | Promotion meaning |
| --- | --- | --- |
| `json-schema` | Workers AI `response_format: { type: "json_schema", json_schema }` | Direct test of Cloudflare's official JSON Mode surface |
| `openai-forced` | OpenAI-style `{ type: "function", function: ... }` tool plus named `tool_choice` | Strong candidate if 3/3 strict succeeds |
| `cf-native-prompted` | Workers AI traditional `{ name, description, parameters }` tool | Discovery only; no API-level force in docs |

Fallback mode is an explicitly separate probe:

- strict mode accepts only `tool_calls` for `submit_image_plan`
- fallback mode accepts `tool_calls` OR JSON content, then decodes with
  `Schema.decodeUnknown(PlanSchema)`
- fallback success is not a strict whitelist fact

## Candidate Source

Default candidates are active Workers AI Text Generation models from
Cloudflare docs. Vision-capable models and models with planned or completed
deprecation are intentionally excluded from the active matrix.

Active official JSON Mode models:

- `@cf/meta/llama-3.1-8b-instruct-fast`
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`

Active non-vision Function calling models:

- `@cf/openai/gpt-oss-120b`
- `@cf/openai/gpt-oss-20b`
- `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `@cf/qwen/qwen3-30b-a3b-fp8`
- `@cf/zai-org/glm-4.7-flash`
- `@cf/ibm-granite/granite-4.0-h-micro`
- `@cf/nvidia/nemotron-3-120b-a12b`

Additional active non-vision Text Generation models from the catalog:

- `@cf/aisingapore/gemma-sea-lion-v4-27b-it`
- `@cf/qwen/qwq-32b`
- `@cf/qwen/qwen2.5-coder-32b-instruct`
- `@cf/meta/llama-guard-3-8b`
- `@cf/meta/llama-3.2-1b-instruct`
- `@cf/meta/llama-3.2-3b-instruct`
- `@cf/meta/llama-3.1-8b-instruct-fp8`
- `@cf/google/gemma-7b-it-lora`
- `@cf/google/gemma-2b-it-lora`
- `@cf/meta-llama/llama-2-7b-chat-hf-lora`
- `@cf/mistral/mistral-7b-instruct-v0.2-lora`

Excluded active Text Generation models because this spike is not testing vision
capability yet:

- `@cf/google/gemma-4-26b-a4b-it`
- `@cf/moonshotai/kimi-k2.6`
- `@cf/meta/llama-3.2-11b-vision-instruct`
- `@cf/meta/llama-4-scout-17b-16e-instruct`
- `@cf/mistralai/mistral-small-3.1-24b-instruct`

## Run

```bash
bun run dev
bash ./test.sh
```

Default `bash ./test.sh` means:

```bash
MODEL_GROUP=active STRATEGIES='json-schema,openai-forced' CONCURRENCY=8 bash ./test.sh
```

Each request attempt runs as an independent bounded-parallel job. Jobs write
individual temp JSON files first; the script merges them into `RESULTS_FILE`
after all jobs complete, so the final JSONL remains deterministic.

Useful overrides:

```bash
MODEL_GROUP=official-json-mode \
STRATEGIES='json-schema' \
ATTEMPTS=3 \
CONCURRENCY=8 \
bash ./test.sh
```

```bash
MODEL_GROUP=function-calling \
STRATEGIES='openai-forced,cf-native-prompted' \
ATTEMPTS=3 \
bash ./test.sh
```

```bash
MODELS='@cf/meta/llama-3.3-70b-instruct-fp8-fast,@cf/zai-org/glm-4.7-flash' \
STRATEGIES='openai-forced' \
ATTEMPTS=3 \
bash ./test.sh
```

```bash
ATTEMPTS=6 SLEEP_SECONDS=2 bash ./test.sh
```

```bash
FALLBACK_ATTEMPTS=3 SLEEP_SECONDS=2 bash ./test.sh
```

## Promotion Rule

Mark a row as a promote candidate only if:

1. The row is strict mode.
2. It returns the expected source for its strategy:
   `json_response` for `json-schema`, `tool_call` for tool strategies.
3. Tool strategies return `toolName === "submit_image_plan"`.
4. `Schema.decodeUnknown(PlanSchema)` succeeds.
5. The row carries `schemaId === "ImgGenPlan.v1"`.
6. The same `(model, strategy, schemaId)` is 3/3 in this spike.

Core promotion still requires a later 6x confirmation run. The 3x matrix is a
coverage pass; it is not the final stable registry.

The future core registry should be tuple-based:

```ts
type StructuredOutputSupport = {
  readonly model: string;
  readonly strategy: "json-schema" | "openai-forced";
  readonly schemaId: "ImgGenPlan.v1";
};
```

Schema remains part of the measured fact. A flat extraction object, a nested
image plan with `minItems`, and a discriminated union are different compliance
classes for a model even though all are JSON Schema. `schemaId` is the narrow
surface: it avoids pretending every app schema is equivalent while keeping the
registry readable.

## Prior Result Snapshot

Run on 2026-05-25 against `@cf/openai/gpt-oss-120b` before this matrix split:

| Mode | Result | Meaning |
| --- | ---: | --- |
| Strict tool call only | 2/3 | `tool_choice` was not reliable enough for whitelist promotion |
| Tool call OR JSON content + Schema decode | 3/3 | Model can emit usable structured data, but not through a strict finalizer |
| Unsupported model | 400 | Fast-fail boundary works |

Decision at that point: do not promote `@cf/openai/gpt-oss-120b` as a strict
structured-submit model for this schema.

## Matrix Result Snapshot

Parallel catalog matrix on 2026-05-25 with
`ATTEMPTS=3 CONCURRENCY=8 MODEL_GROUP=catalog-text
STRATEGIES=json-schema,openai-forced`, and `schemaId=ImgGenPlan.v1`.

| Model | `json-schema` | `openai-forced` |
| --- | ---: | ---: |
| `@cf/aisingapore/gemma-sea-lion-v4-27b-it` | 3/3 | 0/3 `UpstreamError` |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 3/3 | 0/3 `missing_tool_call` |
| `@cf/google/gemma-2b-it-lora` | 3/3 | 3/3 |
| `@cf/google/gemma-7b-it-lora` | 0/3 `UpstreamError` | 0/3 `missing_tool_call` |
| `@cf/ibm-granite/granite-4.0-h-micro` | 3/3 | 3/3 |
| `@cf/meta-llama/llama-2-7b-chat-hf-lora` | 0/3 `UpstreamError` | 0/3 `UpstreamError` |
| `@cf/meta/llama-3.1-8b-instruct-fast` | 3/3 | 3/3 |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | 0/3 `UpstreamError` | 0/3 `missing_tool_call` |
| `@cf/meta/llama-3.2-1b-instruct` | 0/3 `UpstreamError` | 0/3 `schema_decode_failed` |
| `@cf/meta/llama-3.2-3b-instruct` | 3/3 | 3/3 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 3/3 | 1/3 `missing_tool_call` |
| `@cf/meta/llama-guard-3-8b` | 0/3 `UpstreamError` | 0/3 `UpstreamError` |
| `@cf/mistral/mistral-7b-instruct-v0.2-lora` | 0/3 `UpstreamError` | 0/3 `missing_tool_call` |
| `@cf/nvidia/nemotron-3-120b-a12b` | 3/3 | 3/3 |
| `@cf/openai/gpt-oss-120b` | 0/3 `schema_decode_failed` | 3/3 |
| `@cf/openai/gpt-oss-20b` | 0/3 `schema_decode_failed` | 0/3 `missing_tool_call` |
| `@cf/qwen/qwen2.5-coder-32b-instruct` | 3/3 | 0/3 `ResponseDecodeError` |
| `@cf/qwen/qwen3-30b-a3b-fp8` | 3/3 | 3/3 |
| `@cf/qwen/qwq-32b` | 3/3 | 0/3 `ResponseDecodeError` |
| `@cf/zai-org/glm-4.7-flash` | 0/3 `schema_decode_failed` | 3/3 |

The source result file for this run was
`/tmp/agent-os-spike04-catalog-text-parallel-20models-3x.jsonl`.

Promote only rows that survive a later 6x confirmation. This 3x full run is a
coverage pass, not the final stable registry.

Historical official JSON Mode run on 2026-05-25 with
`ATTEMPTS=3 SLEEP_SECONDS=2`,
`MODEL_GROUP=official-json-mode`, `STRATEGIES=json-schema`, and
`schemaId=ImgGenPlan.v1`. This earlier run included deprecated and
vision-capable rows before the current active-matrix exclusion rule:

| Model | Strategy | Strict | Decision |
| --- | --- | ---: | --- |
| `@cf/meta/llama-3.1-8b-instruct-fast` | `json-schema` | 3/3 | 6x candidate |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `json-schema` | 3/3 | 6x candidate |
| `@cf/meta/llama-3-8b-instruct` | `json-schema` | 3/3 | 6x candidate; planned deprecation 2026-05-30 |
| `@cf/meta/llama-3.1-8b-instruct` | `json-schema` | 3/3 | 6x candidate; planned deprecation 2026-05-30 |
| `@hf/nousresearch/hermes-2-pro-mistral-7b` | `json-schema` | 3/3 | 6x candidate; planned deprecation 2026-05-30 |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | `json-schema` | 3/3 | 6x candidate |
| `@cf/meta/llama-3.1-70b-instruct` | `json-schema` | 0/3 | reject in this run: remote network lost; planned deprecation 2026-05-30 |
| `@cf/meta/llama-3.2-11b-vision-instruct` | `json-schema` | 0/3 | blocked: requires account license `agree` |
| `@hf/thebloke/deepseek-coder-6.7b-instruct-awq` | `json-schema` | 0/3 | reject: deprecated by Cloudflare on 2025-10-01 |

6x slow confirmation on the passing rows:

| Model | Strategy | Strict | Decision |
| --- | --- | ---: | --- |
| `@cf/meta/llama-3.1-8b-instruct-fast` | `json-schema` | 6/6 | promote candidate |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `json-schema` | 6/6 | promote candidate |
| `@cf/meta/llama-3-8b-instruct` | `json-schema` | 6/6 | works, but exclude from stable default because planned deprecation is 2026-05-30 |
| `@cf/meta/llama-3.1-8b-instruct` | `json-schema` | 6/6 | works, but exclude from stable default because planned deprecation is 2026-05-30 |
| `@hf/nousresearch/hermes-2-pro-mistral-7b` | `json-schema` | 6/6 | works, but exclude from stable default because planned deprecation is 2026-05-30 |
| `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | `json-schema` | 6/6 | promote candidate |

Stable official-JSON-Mode default candidates from this run:

```ts
const STRUCTURED_OUTPUT_SUPPORT = [
  {
    model: "@cf/meta/llama-3.1-8b-instruct-fast",
    strategy: "json-schema",
    schemaId: "ImgGenPlan.v1",
  },
  {
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    strategy: "json-schema",
    schemaId: "ImgGenPlan.v1",
  },
  {
    model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    strategy: "json-schema",
    schemaId: "ImgGenPlan.v1",
  },
] as const;
```

Run on 2026-05-25 with `ATTEMPTS=6 SLEEP_SECONDS=2`,
`STRATEGIES=openai-forced`, and the non-empty `PlanSchema`:

| Model | Strategy | Strict | Decision |
| --- | --- | ---: | --- |
| `@cf/qwen/qwen3-30b-a3b-fp8` | `openai-forced` | 6/6 | promote candidate |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | `openai-forced` | 6/6 | promote candidate |
| `@cf/zai-org/glm-4.7-flash` | `openai-forced` | 6/6 | promote candidate |
| `@cf/ibm-granite/granite-4.0-h-micro` | `openai-forced` | 6/6 | promote candidate |
| `@cf/moonshotai/kimi-k2.6` | `openai-forced` | 6/6 | promote candidate |
| `@cf/openai/gpt-oss-120b` | `openai-forced` | 4/6 | reject: `missing_tool_call` |

Discovery run on 2026-05-25 with `ATTEMPTS=3 SLEEP_SECONDS=2`,
`STRATEGIES=cf-native-prompted`:

| Model | Strategy | Strict | Decision |
| --- | --- | ---: | --- |
| `@hf/nousresearch/hermes-2-pro-mistral-7b` | `cf-native-prompted` | 3/3 | do not promote: no force primitive, planned deprecation 2026-05-30 |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | `cf-native-prompted` | 1/3 | reject: `missing_tool_call` |
| all other candidate rows | `cf-native-prompted` | 0/3 | reject: upstream rejected native tool shape |

## Decision

Switching models is viable, but the support registry must be tuple-based.
The stable default should start with official JSON Mode rows that are not
already marked for near-term deprecation:

```ts
const STRUCTURED_OUTPUT_SUPPORT = [
  {
    model: "@cf/meta/llama-3.1-8b-instruct-fast",
    strategy: "json-schema",
    schemaId: "ImgGenPlan.v1",
  },
  {
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    strategy: "json-schema",
    schemaId: "ImgGenPlan.v1",
  },
  {
    model: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    strategy: "json-schema",
    schemaId: "ImgGenPlan.v1",
  },
] as const;
```

The `openai-forced` rows remain useful as a second registry for tool-submit
finalizers, but they are not Cloudflare's official JSON Mode surface. The
deprecating 6/6 rows are facts, not stable defaults.

`@cf/openai/gpt-oss-120b` stays out of the tool-submit registry despite
occasional 3/3 runs because the slow 6x run reproduced `missing_tool_call`.
Hermes stays out of stable defaults because the model page marks planned
deprecation on 2026-05-30.

Cloudflare docs used for candidate selection:

- Workers AI function calling:
  https://developers.cloudflare.com/workers-ai/features/function-calling/
- Workers AI traditional function calling:
  https://developers.cloudflare.com/workers-ai/features/function-calling/traditional/
- Workers AI JSON Mode caveat:
  https://developers.cloudflare.com/workers-ai/features/json-mode/
- Workers AI model catalog:
  https://developers.cloudflare.com/workers-ai/models/
