# Spike 07: img-gen shape audit

This spike is a substrate audit, not an img-gen refactor. It models one happy
path:

```text
request -> structured plan -> credit reserve -> job dispatch -> image provider
-> R2 artifact -> delivery -> credit consume
```

The implementation uses only public `@agent-os/core` surface. Places marked
`GAP-Cn` are where the app must forge substrate semantics.

## Run

```bash
cd /Users/yansir/code/52/agentOS/spikes/07-img-gen-shape
bunx wrangler dev

# second terminal
OPENROUTER_KEY=... bash ./test.sh
```

The planning step uses `openai-chat-compatible` route
`openrouter/openai/gpt-4.1`. Image generation itself is intentionally a local
shim because C5 is the object under audit.

## Candidate verdict

| Candidate | Verdict | Note |
|---|---|---|
| C1 cross-DO durable delivery | confirmed | spike needs direct DO RPC from session -> user, user -> session, session -> consumer, consumer -> session |
| C2 durable outbox | disguised duplicate | same generator as C1; sender ledger needs outbound intent + drain, receiver needs idempotent ingest |
| C3 quota refund/release | confirmed | reserve/consume/release is a business resource protocol, not expressible by current `withQuota` |
| C4 R2 blob carrier | not a gap | app can implement INV-9 carrier: R2 stores bytes; ledger stores refs |
| C5 image-output route | confirmed | image generation is provider route capability, not a Tool |

See [GAPS.md](./GAPS.md) for source citations and primitive sketches.
