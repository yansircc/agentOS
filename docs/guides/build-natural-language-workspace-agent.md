# Build A Natural-Language Workspace Agent

## Outcome

User intent reaches agentOS `submit`, the AgentOS Durable Object constructs
request-local workspace tools, workspace metadata is read through ledger
projections, and the product UI consumes typed/redacted run projections or
AG-UI frames instead of raw ledger payloads.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Materialized projections](../concepts/materialized-projections.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)

## Steps

1. Expose one Worker HTTP route that accepts a natural-language prompt.
2. Send only serializable intent and context to an AgentOS Durable Object RPC.
3. Construct workspace tools inside the AgentOS Durable Object, not in the
   Worker caller.
4. Use `createWorkspaceTools` from `@agent-os/workspace-env` with a concrete
   workspace adapter such as `@agent-os/workspace-env-cloudflare`.
5. Let the shared workspace tools provide `read_file`, `write_file`,
   `edit_file`, `glob_files`, `grep_files`, `delete_path`, and `run_shell`.
   Product code must not author raw JSON Schema for these tool contracts.
6. Use `walkWorkspaceFiles` and `diffWorkspaceFiles` for scan/diff. The product
   still owns its `workspace.file.*` event vocabulary and projection shape.
7. Configure the authored agent with a symbolic LLM route binding such as
   `llm.default`; the backend resolves that binding through an `LlmTransport`
   provider route.
8. Bind endpoint and credential through material refs; do not place resolved
   provider URLs or credentials in authored files or product projections.
9. Let the model select product-owned tools through `submit`; do not use
   `unsafeRunToolByName` for LLM-selected tool calls.
10. Store workspace metadata in ledger facts and materialized projections.
11. Keep file bytes, provider URLs, credentials, and tokens out of ledger and
    projection state.
12. Decode agentOS-owned runtime facts with `decodeRuntimeLedgerEvent` or use
    `projectRunTrace` / `projectRunsPage`. Runtime payload fallback parsers in
    product code are a boundary failure.
13. For UI protocols, project typed runtime facts with `@agent-os/ag-ui` only
    when an AG-UI edge stream is required. React/Svelte products consume
    `@agent-os/client-react` or `@agent-os/client-svelte`; AG-UI frames are
    derived edge frames, not ledger facts or canonical client state.
14. Expose product API JSON as a redacted run projection or redacted AG-UI frame
    stream. Do not expose raw ledger payloads, provider-native metadata,
    resolved material values, credentials, tokens, or full file bytes.

## References

- [Usage surfaces](../usage-surfaces.md)
- [Agent authoring package](../packages/agent-authoring.md)
- [Runtime API](../api/runtime.md)
- [Cloudflare DO API](../api/backend-cloudflare-do.md)
