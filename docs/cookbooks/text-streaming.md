# Text Streaming

Use `submitTextStream` when the UI needs token-by-token text, but the app still
wants final turn facts in the ledger.

```ts
return agent.submitTextStream({
  system: "You are a concise support assistant.",
  intent: message,
  context: { customerId },
  route: {
    kind: "openai-chat-compatible",
    endpointRef: "openrouter",
    credentialRef: "OPENROUTER_KEY",
    modelId: "openai/gpt-4.1",
  },
  deliver: { event: "support.message.delivered" },
});
```

SSE frames:

```text
event: token
data: {"delta":"..."}

event: usage
data: {"promptTokens":1,"completionTokens":2,"totalTokens":3}

event: done
data: {"turnId":1,"llmResponseId":2,"deliveredId":3}
```

`done.deliveredId` lets the UI deduplicate this stream with the normal
`streamEvents()` ledger row.

## Boundaries

- v0 supports text only.
- No tools.
- No `outputSchema`.
- Token deltas are not ledger rows.
- Client disconnect writes `agent.aborted.client_disconnect` and does not write
  `llm.response` or the deliver event.
- Adapter support is a capability. Current text LLM route kinds all declare
  `textStream.supported === true`: `cf-ai-binding`,
  `openai-chat-compatible`, `anthropic-messages`, and
  `gemini-generate-content`.
