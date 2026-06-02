# Add A Durable Trigger

## Outcome

You can add app-owned background work that commits one terminal ledger
settlement.

## Prerequisites

- [Durable truth](../concepts/durable-truth.md)
- [Runtime package](../packages/runtime.md)
- [Cloudflare DO backend](../packages/backend-cloudflare-do.md)

## Steps

1. Define a `DurableTrigger` in app code.
2. Parse the intent payload with `parseIntent`.
3. Use `acquire` for provider or tool work.
4. Use synchronous `commit` and `commitCancelled` callbacks for durable facts.
5. Register the trigger with `defineAgentDO({ triggers: [trigger] })`.
6. Submit work with `agent.enqueueTrigger(...)`.

## References

- [Runtime API](../api/runtime.md)
- [Cloudflare DO API](../api/backend-cloudflare-do.md)
