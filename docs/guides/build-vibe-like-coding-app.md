# Build A Vibe-Like Coding App

## Outcome

You can start a first-party coding app with agentOS while keeping product
modules inside the scoped spike until promotion is explicit.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Materialized projections](../concepts/materialized-projections.md)
- [Attached streams](../concepts/attached-streams.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)

## Steps

1. Register product run state with `defineProjection`.
2. Keep run workflow vocabulary in the app module, not a substrate package.
3. Use attached streams for live turn frames.
4. Commit terminal run facts to the ledger.
5. Read current run state through `MaterializedProjections`.
6. Add workspace, tenant config, tools, deploy, HTTP, and ops as spike modules.
7. Record each module status under `spikes/vibe-like-agent-app/docs/`.
8. Promote a module only through a decision that moves code from `spikes/` to
   `packages/`.
9. Keep the exception, sunset, promotion, and retirement mechanics in
   `decisions/a58-first-party-consumer-exception.md`.

## References

- [Runtime API](../api/runtime.md)
- [Cloudflare DO API](../api/backend-cloudflare-do.md)
