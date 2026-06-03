# Build A Natural-Language Workspace Agent

## Outcome

User intent reaches agentOS `submit`, the AgentOS Durable Object constructs
request-local workspace tools, and workspace metadata is read through ledger
projections.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Materialized projections](../concepts/materialized-projections.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)

## Steps

1. Expose one Worker HTTP route that accepts a natural-language prompt.
2. Send only serializable intent and context to an AgentOS Durable Object RPC.
3. Construct workspace tools inside the AgentOS Durable Object, not in the
   Worker caller.
4. Configure `submit` with `openAIChat({ endpoint, credential, model })`.
5. Bind endpoint and credential through material refs; do not parse provider
   responses in product code.
6. Let the model select product-owned tools through `submit`.
7. Store workspace metadata in ledger facts and materialized projections.
8. Keep file bytes, provider URLs, credentials, and tokens out of ledger and
   projection state.
9. Use `runToolByName` only for deterministic UI/system actions, never for
   LLM-selected tool calls.

## References

- [Runtime API](../api/runtime.md)
- [Kernel API](../api/kernel.md)
- [Cloudflare DO API](../api/backend-cloudflare-do.md)
