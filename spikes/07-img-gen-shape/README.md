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
# .dev.vars must contain OPENROUTER_KEY=...
bunx wrangler dev

# second terminal
bash ./test.sh
```

Last live smoke: 2026-05-26, `PASS: 6  FAIL: 0`.

The planning step uses `openai-chat-compatible` route
`openrouter/openai/gpt-4.1`. Image generation uses `generateImage` with
`openai-chat-compatible-image` route
`openrouter/google/gemini-2.5-flash-image`; R2 materialization remains app
carrier code.

## Candidate verdict

| Candidate | Verdict | Note |
|---|---|---|
| C1 cross-DO durable delivery | resolved by P1 | spike uses `dispatchToScope` for session -> user, user -> session, session -> consumer, consumer -> session |
| C2 durable outbox | collapsed into C1 | `dispatch_outbox` is the sender pending buffer behind `dispatchToScope`, not a separate primitive |
| C3 quota refund/release | resolved by P2 | user scope owns `grantResource` / `reserveResource` / `consumeResource`; session only dispatches requests |
| C4 R2 blob carrier | not a gap | app can implement INV-9 carrier: R2 stores bytes; ledger stores refs |
| C5 image-output route | resolved by P3 | consumer uses `generateImage`; R2 materialization remains app carrier code |

See [GAPS.md](./GAPS.md) for source citations and primitive sketches.
