# a85 Effect AI Transport Spike Verdict

## Verdict

`adapter viable, full replacement not viable now`.

stable axis: agentOS owns submit, ledger facts, tool algebra, structured admission fingerprints, material refs, and provider error taxonomy.
change axis: LLM provider client implementation.
invariant: provider transport may change, but it cannot become a second source for agentOS tool/runtime/admission algebra.

## Evidence

- Installed and typechecked against:
  - `@effect/ai@0.35.0`
  - `@effect/ai-openai@0.39.2`
  - `@effect/ai-anthropic@0.25.0`
  - `@effect/ai-google@0.14.0`
  - `effect@3.21.2`
- Prototype:
  - `/private/tmp/agentos-effect-ai-spike/src/effect-ai-adapter-prototype.ts`
  - `npm run typecheck` passes.
- Runtime smoke:
  - `/private/tmp/agentos-effect-ai-spike/runtime-json-schema-smoke.mjs`
  - Passing an agentOS JSON Schema object into `Tool.make(..., { parameters })` throws inside Effect Schema AST construction.

## Matrix

| Capability                  | Result                                | Evidence / gap                                                                                                                                                                                  |
| --------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI-compatible endpoint  | viable as adapter                     | `OpenAiClient.make({ apiUrl, apiKey })` supports route-owned endpoint material.                                                                                                                 |
| Anthropic endpoint/version  | viable as adapter                     | `AnthropicClient.make({ apiUrl, apiKey, anthropicVersion })` supports route-owned endpoint/version material.                                                                                    |
| Gemini endpoint             | viable as adapter                     | `GoogleClient.make({ apiUrl, apiKey })` exists and Google metadata includes `thoughtSignature`.                                                                                                 |
| Cloudflare AI binding       | not covered                           | No installed Effect AI Cloudflare AI provider. Current `cf-ai-binding` route remains custom unless explicitly removed.                                                                          |
| Tool call response shape    | viable for static Effect Schema tools | Effect AI response exposes `id`, `name`, `params`, `usage`, provider metadata, and `disableToolCallResolution`.                                                                                 |
| agentOS product tools       | viable after a86                      | The spike proved direct raw JSON Schema input fails. The selected path is to move tool/admission authoring to agentOS `AgentSchema`, then project to Effect AI tools.                           |
| Structured output admission | viable after a86/a88                  | `generateObject` requires Effect Schema. agentOS must own `AgentSchema`, schema fingerprinting, evidence keys, and provider strategy facts before structured admission can move onto Effect AI. |
| Usage accounting            | adapter viable with hard failure      | Effect AI usage fields are optional; adapter must fail if any required token field is absent, not guess zeros.                                                                                  |
| Abort / timeout             | not proven for full replacement       | `LanguageModel.generateText` options do not accept the current `AbortSignal` directly. Adapter must bridge signal to Effect interruption and prove provider HTTP abort.                         |
| Error taxonomy              | adapter work required                 | Effect AI has `AiError` classes, but agentOS still owns `UpstreamFailure`, `ProviderHttpFailure`, and structured admission outcomes. Mapping must stay agentOS-owned.                           |
| Provider material secrecy   | viable as adapter                     | Provider credentials/endpoints can be resolved before client/model construction and need not enter ledger-visible payloads.                                                                     |
| Gemini metadata round-trip  | viable as adapter                     | Google provider augments Prompt/Response metadata with `thoughtSignature`; adapter can map to `LlmToolCall.metadata`.                                                                           |

## Decision

Do not replace the current protocol adapter wholesale in a85.

Follow-up decision after review: take the breaking path in a86-a90. Later
external-framework review expands the logical chain with a93 provider output
item ADT before a87/a88 and a94 trace/OTLP projection before a90 close-out.
Effect Schema becomes the canonical tool/structured schema source first; then
Effect AI can replace the provider protocol layer as an agentOS-owned adapter.

Use Effect AI only behind an agentOS-owned adapter:

```text
agentOS route/material/admission/tool algebra + Effect Schema source
  -> agentOS Effect-AI adapter
  -> @effect/ai LanguageModel
```

The adapter must keep these facts owned by agentOS:

- `LlmRoute` taxonomy and route fingerprints.
- `AgentSchema` source, `AgentSchema -> provider JSON Schema` projection, and schema fingerprinting.
- Structured admission evidence, strategy keys, and lease ordering.
- `LlmResponse` usage requirements.
- Provider error classification into agentOS abort/admission outcomes.

## Required Before Full Replacement

Full provider-protocol replacement becomes viable only if one of these is implemented:

1. agentOS changes its canonical tool/structured schema source from closed JSON Schema to Effect Schema; or
2. agentOS owns a total `JsonSchemaObject -> AgentSchema` compiler with proof
   tests preserving fingerprints and provider JSON Schema output.

The selected path is 1.

Without one of those, full replacement would create two schema generators:

```text
agentOS JSON Schema/fingerprint
@effect/ai Effect Schema/tool JSON generation
```

That violates `every internal algebra has one code source`.

## Follow-up Tasks

- `tasks/a86a-agent-schema-profile-spike.md`
- `tasks/a86-effect-schema-canonical-source.md`
- `tasks/a87-effect-ai-transport-adapter.md`
- `tasks/a88-structured-admission-effect-ai.md`
- `tasks/a89-delete-old-protocol-schema-sources.md`
- `tasks/a90-product-consumption-web-cursor-proof.md`

## Verification Run

```sh
cd /private/tmp/agentos-effect-ai-spike
npm run typecheck
node runtime-json-schema-smoke.mjs
```

Observed:

```text
typecheck: pass
runtime smoke: TypeError Cannot read properties of undefined (reading '_tag')
```
