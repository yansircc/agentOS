# Protocol Adapter Live-Wire Notes

This cookbook records the live-wire adapter findings after the runnable spikes
were retired. Core behavior is now covered by contract tests; these notes only
explain why the adapter laws have their current shape.

## Invariant

Capability evidence is keyed by the actual wire surface:

```text
(routeFingerprint, schemaFingerprint, strategy, adapterVersion)
```

`route.kind` is therefore semantic. Native Anthropic, native Gemini, OpenAI
Chat Completions-compatible, and Cloudflare AI binding routes must not share
capability leases just because the model name or prompt looks similar.

## Live-Wire Verdicts

| Wire | Route kind | Model / provider | Verdict |
|---|---|---|---|
| Cloudflare AI binding | `cf-ai-binding` | `@cf/openai/gpt-oss-120b` | Admission algebra passed; forced-tool-call reliability was model-flaky. |
| Anthropic Messages via aihubmix | `anthropic-messages` | `claude-sonnet-4-6` | 5/5 structured reliability on the small live-wire sample. |
| Google Gemini Generate Content | `gemini-generate-content` | `gemini-3.1-flash-lite` | 5/5 structured reliability on the small live-wire sample. |

## Class-Eliminating Fixes

| Finding | Fix |
|---|---|
| Transport errors are wrapped in `UpstreamFailure`, so `classify` saw the wrapper instead of the HTTP cause | Shared `unwrapErrorMessage` helper reads the wrapped cause before provider-specific classification. |
| Gemini 3.1+ requires `thoughtSignature` to round-trip across tool calls | `LlmToolCall.metadata` carries opaque adapter metadata; Gemini captures and re-emits the signature. |
| Gemini rejects JSON Schema fields accepted by the substrate (`additionalProperties`, `$schema`, `$id`, `$ref`) | Gemini adapter sanitizes only the wire copy; the original schema remains the SSoT for fingerprinting and local validation. |
| Gemini can report credential failures as HTTP 400 with `API_KEY_INVALID` / `PERMISSION_DENIED` | Gemini classifier maps those bodies to `AuthError` before generic 400 handling. |

## Structured Path

```text
submit({ outputSchema })
  -> makeSchemaContract(schema)
  -> routeFingerprint(normalized route)
  -> getProtocolAdapter(route.kind)
  -> adapter.encodeStructured(...)
  -> dispatchProvider(route, body)
  -> adapter.decodeStructured(...)
  -> validateAgainstSchema(original schema)
  -> llm.structured.evidence
```

Adapter encoding may lower or sanitize provider-specific wire details. It must
not mutate the schema contract, route identity, evidence key, or local decode
validator.

## Turn Path

```text
submit({ tools })
  -> getProtocolAdapter(route.kind)
  -> adapter.encodeTurn(...)
  -> dispatchProvider(route, body)
  -> adapter.decodeTurn(...)
  -> tool.executed / llm.response ledger rows
```

The protocol adapter owns wire translation only. The agent loop, admission
projection, tool execution, and ledger vocabulary stay protocol-agnostic.
