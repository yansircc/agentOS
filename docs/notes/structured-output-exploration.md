# Note: Structured Output — explored, deferred from MVP

> Date: 2026-05-25
> Branch: explored and reverted (was on track to v0.2.9)
> Decision driver: MVP scope; CF Workers AI structured output reliability
> remains provider-dependent; no current first-party app needs it

## TL;DR

`withStructuredOutput` / `outputSchema` was prototyped and works against
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` via a two-stage finalizer. The
implementation was reverted before v0.2.9 commit because:

1. Workers AI's "JSON Mode" still does not enforce the schema strictly
   (model may invent its own fields; we must decode and reject).
2. Non-OpenAI Chat Completions response shapes (`{response: string|object}`)
   require widening our `LlmResponseSchema` union, plus a stringify
   round-trip path. Two response shapes in core for one MVP feature.
3. No current reference app actually needs structured output. ImgGen /
   Insight Helper plans use free-text deliverables.
4. The Schema instance does not survive Cloudflare DO RPC (prototype lost).
   Apps must construct schemas inside the AgentDO subclass and route
   through subclass RPC methods. Workable but a non-trivial DX caveat.

## Designed but not shipped

API shape (per codex's narrow-version recommendation):

```ts
submit({
  ...,
  outputSchema: Schema.Struct({...}),     // must live in DO subclass bundle
  deliver: { event: "..." },
});
// SubmitResult.output: unknown (decoded via Schema.decodeUnknown internally)
```

Internals (two-stage):
1. Normal agent loop — tools may be called, LLM produces free text.
2. On natural stop, run a finalizer LLM call:
   - No tools
   - `response_format: { type: "json_schema", json_schema: {name, schema, strict:true} }`
   - Parse content as JSON, then `Schema.decodeUnknown(outputSchema)`
3. Decode failure → `ABORT.STRUCTURED_OUTPUT = "agent.aborted.structured_output"`
4. Model not in `NATIVE_STRUCTURED_OUTPUT_MODELS` whitelist → `UnsupportedStructuredOutputModel`
   fast-fail at the Promise boundary (does NOT enter ledger; config error)

Implementation touched:
- errors.ts: ABORT.STRUCTURED_OUTPUT, StructuredOutputFailure, UnsupportedStructuredOutputModel
- llm.ts: `response_format` field on LlmRequest; Workers-AI-native response shape (Schema.Union);
  NATIVE_STRUCTURED_OUTPUT_MODELS + supportsNativeStructuredOutput
- submit-agent.ts: outputSchema field; two-stage finalizer; finalAbort + catchTag for STRUCTURED_OUTPUT
- agent-do.ts: supportsNativeStructuredOutput check before runtime is built

## Spike-03 raw findings (retained here; runnable spike retired)

| Configuration | Pass rate | Notes |
|---|---|---|
| `@cf/openai/gpt-oss-120b` + `response_format: json_schema` (strict:true) | 0-1/3 | Schema silently ignored |
| `@cf/openai/gpt-oss-120b` + tool-submit + `tool_choice` forcing | 3/3 | But model fabricates schema fields sometimes |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` + `response_format` | works at API level | Model fabricates outer shape (e.g. wraps in `{analysis: {...}}`) |

Verdict: Cloudflare Workers AI's JSON Mode is "best effort", not contractual.
Substrate must still Schema-decode the result and route mismatches to
StructuredOutputFailure.

## When to revisit

Resume from this note when EITHER:
- First reference app surfaces a real structured-output need (most likely
  Img-Gen's plan generation), OR
- Cloudflare ships a Workers AI model that strictly enforces JSON Schema
  (and gets added to `NATIVE_STRUCTURED_OUTPUT_MODELS`)

At that point, the explored design above can be implemented mostly intact.
Open questions to re-decide:

1. **DX**: requires app to put `outputSchema` instance in same module as
   the AgentDO subclass (RPC limitation). Worth a documented pattern or
   helper API (e.g., AgentDO.registerSchema("plan", PlanSchema) + reference
   by name in submit). Codex's `outputSchema: Schema.Schema<...>` is the
   cleanest spec-level shape; the registration-by-name workaround is a
   secondary path for cases where the schema is dynamic.
2. **Provider routing**: Anthropic via OpenAI-compat — does it honor
   `response_format`? Untested. Will probably require widening the model
   whitelist case-by-case after empirical validation.
3. **Streaming**: deferred entirely; the finalizer call could stream the
   JSON for low-latency, but Schema.decodeUnknown is sync — would need
   partial-decode story.

## Pointers

- Codex review correspondence (2026-05-25 conversation): defines the
  "structured submit finalizer" mental model and the "native-only" narrow
  cut.
- The retired spike-03 implementation compared `response_format:
  json_schema` with `tool_choice`-forced submit tool patterns. The durable
  findings are retained in this note; runnable spike code is no longer a
  tracked repo surface.
