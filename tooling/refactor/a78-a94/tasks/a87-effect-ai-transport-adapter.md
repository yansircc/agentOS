# a87: Effect AI Transport Adapter

## Summary

stable axis: `LlmTransport.call()` remains the runtime boundary; agentOS owns routes, material refs, fingerprints, budget, ledger, admission, and execution domains.  
change axis: provider client/model call implementation and message/tool-call projection.  
invariant: Effect AI consumes agentOS-owned algebra; it does not become the source of runtime facts.

This task depends on a86 and a93. Do not start while raw JSON Schema is still
the canonical tool/structured schema source, and do not consume provider-native
or Effect AI response parts directly from submit/admission code.

## Key Changes

- Add `@agent-os/llm-transport-effect-ai` or an equivalent backend-internal package.
- Build Effect AI provider clients/models from agentOS `LlmRoute` and resolved material refs:
  - OpenAI-compatible routes use `OpenAiClient.make({ apiUrl, apiKey })` only
    if the route is proven to preserve chat-completions semantics through Effect
    AI;
  - if Effect AI uses Responses semantics, introduce a distinct
    `openai-responses` route/fingerprint instead of reusing
    `openai-chat-compatible`;
  - Anthropic routes use `AnthropicClient.make({ apiUrl, apiKey, anthropicVersion })`;
  - Gemini routes use `GoogleClient.make({ apiUrl, apiKey })`.
- Keep provider material resolver-side:
  - credentials, endpoint values, and provider-native model objects never enter ledger, projections, runtime events, or API payloads.
- Generate `@effect/ai Tool` / `Toolkit` from agentOS tools and Effect Schema.
- Always use `disableToolCallResolution: true`; tool execution stays in agentOS submit/admit/ledger flow.
- Reject any provider-executed tool result. Effect AI may surface unresolved tool
  call requests only.
- Normalize Effect AI response parts into the a93 agentOS provider output item
  ADT, then derive `LlmResponse` / runtime facts from that ADT:
  - text;
  - reasoning item presence and redacted summary references where supported;
  - tool call id/name/JSON arguments;
  - tool result/function-call-output parts when the provider requires them in
    next-turn prompt construction;
  - usage tokens;
  - provider metadata needed for later turns, especially Gemini `thoughtSignature`.
- Usage fields are required. Missing token counts hard fail; do not guess zero.
- Bridge agentOS cancellation/timeouts into Effect interruption/provider abort and prove HTTP request cancellation.
- Preserve only allowlisted provider metadata needed for later turns. Gemini
  `thoughtSignature` must round-trip across a multi-turn fixture without leaking
  provider material.
- Decide `cf-ai-binding` explicitly:
  - delete the route if no current product requires it; or
  - keep a custom non-Effect-AI route and document that it is outside the Effect AI adapter.

## Tests

- OpenAI-compatible free-text turn parity with the old adapter.
- Anthropic free-text turn parity with the old adapter.
- Gemini free-text turn parity with the old adapter, including thought signature round-trip.
- Tool call id/name/arguments round-trip with `disableToolCallResolution: true`.
- Sentinel tool handlers are never called.
- Provider-executed tool calls/results are rejected.
- Tool result messages map back into provider prompt shape.
- Tool result prompt conversion fails if it would emit an empty tool name.
- Usage missing any required token field fails.
- Existing zero-usage fallback fixtures are deleted or rewritten to expect
  failure before a89 removes the old protocol code.
- Resolved provider material does not appear in emitted events, projections, or logs.
- Abort signal cancels a slow provider request.
- Effect AI toolkit projection cannot execute tools and cannot erase
  `Tool.execution`; an undeclared effectful domain still fails during
  `lowerAgentConfig`.
- `LlmTransport.call()` does not require `LanguageModel` context from callers; provider model is closed over inside the transport service.
- Submit/admission code has no direct dependency on Effect AI response classes,
  OpenAI Responses JSON, Anthropic content blocks, Gemini candidates, or
  chat-completions message blobs.

## Gates

Full root gates plus live provider smoke only when explicitly enabled by local credentials.

## Assumptions

- a86 has already made Effect Schema the only schema source.
- a93 has introduced the provider output item ADT and migrated provider adapters
  to use it as their only runtime-facing output shape.
- Effect AI is provider projection only. It does not own submit loop, ledger, admission evidence, or execution domains.
