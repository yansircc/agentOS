# a85: Effect AI Transport Replacement Spike

## Summary

stable axis: agentOS owns submit loop, ledger events, admission, material refs, claim settlement, and execution domains.  
change axis: LLM provider transport implementation.  
invariant: replacing transport must not let `@effect/ai` become a second source for agentOS tool/runtime algebra.

This is an evaluation spike. It must produce a written verdict before any full replacement lands.

Current spike verdict: `adapter viable, full replacement not viable now`.
See `../effect-ai-spike-verdict.md`.

Follow-up decision: choose the breaking migration path. a86 moves canonical
tool/structured schemas to Effect Schema; a87-a89 then replace provider protocol
code through an agentOS-owned Effect AI adapter.

## Spike Questions

- Can `@effect/ai` implement the current `LlmTransport.call(request, { signal })` contract for all existing route kinds?
- Can it preserve agentOS `LlmResponse` exactly: text, tool calls, usage, and protocol metadata needed for later turns?
- Can it support structured-output admission without weakening route fingerprints or evidence semantics?
- Can it use agentOS `RefResolverService` material refs without exposing resolved provider material to ledger/projection?
- Can provider errors map to current `UpstreamFailure` / admission outcome classes without losing retry/rate-limit/auth distinctions?

## Required Prototype

- Create an isolated spike package/worktree, not a production package.
- Install current `@effect/ai` and required peers.
- Build a minimal adapter from agentOS `LlmRequest` to `@effect/ai` model calls for at least:
  - OpenAI-compatible chat route.
  - Anthropic messages route if supported by the current API.
  - Tool calling with one function tool.
  - Structured output / forced tool call or explicit proof that current `@effect/ai` cannot express it.
- Typecheck the adapter against current agentOS `LlmTransport`, `LlmRoute`, `LlmRequest`, and `LlmResponse` types.
- Produce `effect-ai-spike-verdict.md` with one of:
  - `full replacement viable`;
  - `adapter viable, full replacement not viable`;
  - `not viable now`.

## Acceptance Criteria

Full replacement is viable only if the prototype proves:

- Abort/cancellation can flow from agentOS budget timeout into provider calls.
- Usage accounting is available or can be derived without guessing.
- Tool call IDs, names, JSON arguments, and tool response correlation round-trip.
- Gemini/metadata-style protocol round-trip has an equivalent escape hatch, or Gemini is explicitly excluded from full replacement.
- Structured-output admission can retain current lease/fingerprint semantics.
- No provider URL, credential, or provider-native object enters ledger-visible payloads.

If any item fails, the outcome must be `adapter viable` or `not viable now`; do not force a full replacement.

## Follow-up Plan If Viable

- Do not replace the current protocol adapter wholesale.
- Optional next task: add `@agent-os/llm-transport-effect-ai` as an adapter package only.
- Keep agentOS `LlmTransport` as the runtime boundary.
- Keep route constructors/fingerprints, material refs, `AgentSchema`, schema
  fingerprinting, and structured evidence owned by agentOS.
- Use Effect AI only after provider model construction is closed over inside the transport service; `call()` must not require `LanguageModel` context.
- Full replacement requires either:
  - moving agentOS canonical schemas to `AgentSchema`; or
  - an agentOS-owned total `JsonSchemaObject -> AgentSchema` compiler with
    proof tests preserving fingerprints and provider JSON Schema output.

## Gates

- Spike typecheck.
- Spike report with explicit matrix for OpenAI-compatible, Anthropic, Gemini, tool calls, structured output, usage, abort, errors, and metadata.
- Root repo is not modified except for task docs unless a later implementation task is opened.
