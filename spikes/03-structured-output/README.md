# Spike 03: Structured Output Modes for withStructuredOutput

> Validate which mode the CF AI binding actually supports, so we don't
> guess the public API shape for `withStructuredOutput`.

## Core question

Two candidate shapes for getting schema-typed LLM output:

**Mode A: `response_format: { type: "json_schema" }`**
The OpenAI Chat Completions / Responses API field that constrains the LLM
to emit JSON conforming to the schema. Cleaner from a substrate perspective
(no fake "submit" tool, output is just `text` parsed against schema).

**Mode B: single-tool-submit**
Define a `submit_X` tool whose `parameters` IS the desired output schema.
Prompt the LLM to call it. The tool args become the structured output.
Works even on models that don't support response_format, because tool
calling is universal.

We don't know which one CF Workers AI's `@cf/openai/gpt-oss-120b` actually
respects. The spike tests both, side by side, on the same prompt + schema.

## Hypotheses

| # | Hypothesis | How to test |
|---|---|---|
| H1 | gpt-oss-120b honors `response_format: json_schema`: returns valid JSON in `choices[0].message.content` | POST `/test/a` and `JSON.parse(content)`; validate against schema |
| H3 | gpt-oss-120b reliably calls `submit_analysis` tool with schema-matching args | POST `/test/b` and check `tool_calls[0].function.arguments` is valid JSON matching schema |
| H1 | Behavior is consistent across 3 attempts (no flakiness) | Repeat each test 3x |

H2/H4 (Anthropic via OpenAI compat) deferred — they need unified billing
credits. Once H1/H3 land we can re-run against frontier models.

## Schema used

```json
{
  "type": "object",
  "properties": {
    "summary":   { "type": "string" },
    "sentiment": { "type": "string", "enum": ["positive", "negative", "neutral"] },
    "keywords":  { "type": "array", "items": { "type": "string" } }
  },
  "required": ["summary", "sentiment", "keywords"]
}
```

Prompt:
```
Analyze this text: "agent-OS is clean and works well. The error vocabulary is great."
```

## Pass criteria

- Mode A passes if: `choices[0].message.content` is a JSON string that parses
  AND contains all required fields with correct types.
- Mode B passes if: `choices[0].message.tool_calls[0].function.arguments`
  parses as JSON AND contains all required fields with correct types.

## Decision matrix

| Mode A result | Mode B result | Public API for withStructuredOutput |
|---|---|---|
| works | works | Prefer A (cleaner). Document B as fallback for non-OpenAI providers. |
| works | works less reliably | A only. |
| broken | works | Single-tool-submit pattern; expose `withStructuredOutput(toolSchema)` that wraps a synthetic submit tool internally. |
| broken | broken | Defer feature; agents return free text only. |

## Out of scope

- Anthropic / Gemini / other providers (need credits)
- Streaming structured output
- Partial / incremental schemas
- Strict mode tuning

## Results (run on @cf/openai/gpt-oss-120b)

| Configuration | Pass rate | Notes |
|---|---|---|
| Mode A: `response_format: json_schema` (default max_tokens) | 0/3 to 1/3 | `content: null` (token cap) and/or schema silently ignored — model invents its own fields like {sentiment, topics, entities, key_phrases, language, ...} despite explicit `strict: true` |
| Mode A: with `max_tokens: 2048` | 0/3 to 1/3 | same — schema is never enforced; flake range tracks reasoning_content size |
| Mode B: tools only, no `tool_choice` forcing | 2/3 | works when LLM cooperates; sometimes returns free text instead of calling the tool |
| **Mode B: tools + `tool_choice: { type: "function", function: { name: "submit_analysis" } }`** | **3/3** | reliable — LLM is forced to call the named tool; args always parse + match schema |

## Verdict

**`response_format: json_schema` is unreliable on `@cf/openai/gpt-oss-120b`.**
Workers AI accepts the field but does not enforce the schema. Recovery via
`max_tokens` increase does not fix the core issue.

**Ship `withStructuredOutput` as single-tool-submit + `tool_choice` forcing.**
Use a synthetic submit tool whose `parameters` is the desired schema, and
force the LLM to call it via `tool_choice`. The tool args ARE the structured
output (already JSON-schema-valid because the model fills the schema'd
parameters).

## Implications for v0.2.8 `withStructuredOutput`

The substrate work for v0.2.8:

```ts
// Public API candidate (subject to ImgGen-style usage validation)
submitAgent({
  intent: "Generate image plan",
  context: { ... },
  agent: { provider: "@cf", model: "openai/gpt-oss-120b" },
  outputSchema: Schema.Struct({ images: Schema.Array(...) }),
  // (other tools allowed but final output forced to submit_structured)
  deliver: { event: "plan.generated" },
});
// SubmitResult.output is Schema.Type<typeof outputSchema>
```

Internal mechanics:
1. agent-OS synthesizes an internal `_submit_structured` tool with
   `parameters = JSONSchema(outputSchema)`.
2. On the final LLM turn, the loop adds `tool_choice: { type:"function",
   function: { name: "_submit_structured" } }` to force the LLM.
3. When `_submit_structured` is called, args become the structured output.
   Loop terminates; SubmitResult.output is typed via outputSchema.
4. effect/Schema decodes the args to enforce types (defense-in-depth even
   though the model is constrained by the parameters schema).

## Deferred — needs validation when v0.2.8 lands

- Anthropic via OpenAI compat: does `tool_choice` work the same way?
- Streaming structured output (incremental schema fields)
- Mid-loop branches: a tool call AND a structured output both required
  before terminating — probably 2-call agent design
- Cost/latency vs Mode A across providers

## Status

- [x] code written
- [x] runs on @cf/openai/gpt-oss-120b
- [x] verdict: Mode B + tool_choice = ship pattern
- [ ] v0.2.8 implementation
