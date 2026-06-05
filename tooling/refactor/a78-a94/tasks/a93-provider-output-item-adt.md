# a93: Provider Output Item ADT

## Summary

stable axis: submit, admission, ledger settlement, budget, material refs, route
fingerprints, and execution domains are agentOS-owned.  
change axis: provider-native response shapes and Effect AI response part APIs.  
invariant: provider responses normalize through one agentOS-owned output item
ADT before runtime logic consumes them.

This task should run before a87/a88 if the Effect AI adapter has not already
landed. It prevents Effect AI, OpenAI Responses JSON, Anthropic content blocks,
Gemini candidates, or chat-completions blobs from becoming hidden runtime
sources.

## Key Changes

- Add an agentOS-owned provider output item ADT. OpenAI Responses is the
  reference shape, but not the source of truth:
  - message/text item;
  - reasoning item, with redacted summary refs where supported;
  - function/tool call item with `callId`, name, and decoded JSON arguments;
  - function/tool result item for next-turn provider prompt construction;
  - refusal/error item where providers expose it as model output;
  - usage item or required usage metadata;
  - allowlisted provider continuation metadata, such as Gemini
    `thoughtSignature`, as symbolic or redacted metadata.
- Make provider adapters return only the ADT to runtime callers.
- Make submit/admission consume only the ADT and never provider-native response
  classes or raw JSON.
- Keep hosted/provider-executed tools distinct from agentOS app tool execution:
  - provider-executed tool activity is not `Tool.execution`;
  - if durable relevance is needed, record a symbolic provider-tool fact or
    proof ref with a separate owner;
  - unresolved app tool calls continue through agentOS submit/admit/quota/ledger
    execution.
- Add an adapter version fact used in route/admission fingerprints when the ADT
  mapping changes.
- Delete or demote chat-only response parsing from new provider surfaces.

## Tests

- OpenAI Responses fixtures normalize `message`, `reasoning`, `function_call`,
  and `function_call_output` into the ADT.
- Chat-completions fixtures normalize through the same ADT without becoming the
  preferred runtime shape.
- Anthropic fixtures normalize text/tool-call/provider metadata through the ADT.
- Gemini fixtures normalize text/tool-call/usage and preserve only allowlisted
  continuation metadata.
- Missing required usage fails before submit/admission can write facts.
- Submit/admission code has no direct imports from provider protocol response
  modules or Effect AI response part classes.
- Hosted/provider-executed tool output cannot be recorded as an agentOS app tool
  execution fact.
- Changing ADT adapter version rekeys structured-admission evidence.

## Gates

Full root gates plus focused grep gates:

```sh
git grep "OpenAI\\|Anthropic\\|Gemini\\|LanguageModel\\|ResponsePart" packages/runtime packages/kernel
```

Runtime/kernel hits must be type names owned by agentOS or test fixtures. Direct
provider SDK response imports in submit/admission/runtime settlement paths fail.

## Assumptions

- Effect AI remains provider projection only.
- The ADT does not store raw provider responses in ledger facts or projections.
- Provider-specific prompt reconstruction may live in provider adapters, but the
  runtime-facing output shape is agentOS-owned.
