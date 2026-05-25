# Spike 1: End-to-End Minimum Loop

> Single point penetration. One spike, four assumptions falsified or confirmed in one run.

## Core hypothesis

A submitAgent call can complete the full loop using **only CF bindings + ~150 lines TS**:

```
HTTP /submit
  → AgentDO addressed by scope id
  → ingest event logged to DO SQLite
  → env.AI.run("anthropic/claude-sonnet-4-6", { messages, tools })
  → tool call dispatched (single trivial tool: get_current_time)
  → tool result fed back to LLM
  → final response logged
  → deliver event triggers on() callback in same DO
  → HTTP response returned
```

## Four assumptions tested simultaneously

| # | Assumption | Pass criterion |
|---|---|---|
| A1 | `env.AI.run` routes to third-party frontier model (anthropic/...) | Successful response with `usage` containing input/output tokens |
| A2 | DO + SQLite as ledger backend | Event row queryable after request returns |
| A3 | HTTP fetch → DO RPC (`stub.submit()`) round-trips intact | Response payload matches expected shape |
| A4 | `on(eventKind, handler)` fires inside the same DO when log emits that event | Callback executed before HTTP response is sent |

## Out of scope (deferred to later spikes)

- Workflow / step.waitForEvent (→ spike 2)
- Sandbox carrier (→ spike 3)
- Prompt cache via OpenAI compat (→ spike 4)
- Session API auto-compaction (→ spike 5)
- AutoRAG (→ spike 6)
- Quota middleware
- Structured output

## Setup

```sh
cd ~/code/52/agentOS/spikes/01-minimum-loop
bun install
wrangler login  # if not already
# create AI Gateway in dashboard; copy account_id + gateway_id into wrangler.jsonc
bun run dev
```

## Run

```sh
curl -X POST http://localhost:8787/submit \
  -H 'content-type: application/json' \
  -d '{"scope":"test-scope-1","prompt":"what time is it now?"}'
```

Expected:
- 200 response with assistant text mentioning current time
- DO SQLite contains 3+ events: `chat.ingested`, `llm.response`, `tool.executed`, `agent.delivered`
- console log of `on('agent.delivered')` callback

## Falsification triggers

| Failure | What's broken |
|---|---|
| `env.AI.run` 4xx for `anthropic/...` | A1 — AI Gateway unified billing or model routing not as documented |
| SQLite write fails | A2 — DO SQLite semantics differ from assumption |
| stub.submit() throws | A3 — DO RPC binding form differs |
| `on()` callback never fires | A4 — reactive layer requires different mechanism (alarm? channel?) |

## Status

- [ ] code written
- [ ] runs locally (miniflare)
- [ ] runs on production (wrangler deploy)
- [ ] writeup: which assumptions confirmed, which fell
