# Spike 2: Suspendable Agent via CF Workflows

> Validates that agent.run can pause for hours/days at `step.waitForEvent`
> and resume on external `sendEvent`, with same-scope DO ledger + AI binding
> accessible from inside the workflow.

## Core hypothesis

A workflow can drive an interview-style agent loop:
```
start(scope, topic)
  → workflow.create({ id: scope, params })
  → step.do  "init"        (logs interview.started)
  → step.do  "ask question" (calls env.AI.run → logs interview.asked)
  → step.waitForEvent       (SUSPENDED until sendEvent fires)
  ──── time passes ─────
external POST /answer
  → workflow.get(scope).sendEvent({ type: "user-answer", payload })
  → step.do  "record answer" (logs interview.answered)
  → step.do  "finalize"     (calls env.AI.run → logs brief.written)
  → workflow completes
```

## Four assumptions tested

| # | Assumption | Pass criterion |
|---|---|---|
| B1 | `step.waitForEvent` actually suspends the workflow (no busy loop, no premature completion) | `instance.status()` returns paused/waiting state between /start and /answer |
| B2 | Workflow instance id = app-controlled string (here: `scope`) | `create({ id: scope })` succeeds and `.get(scope)` returns same instance |
| B3 | Workflow can call AI binding + cross-DO RPC from inside steps | `interview.asked` and `brief.written` events appear in ledger; both contain non-empty LLM text |
| B4 | `sendEvent` resumes the workflow to completion | After /answer, status reaches `complete`; `interview.answered` event appears |

## Falsification triggers

| Failure | What's broken |
|---|---|
| status returns "complete" immediately after /start | B1 — waitForEvent did not suspend |
| `.create({ id: scope })` errors or returns different id | B2 — instance id not user-controllable |
| `interview.asked` or `brief.written` missing | B3 — Workflow → AI binding or Workflow → DO RPC broken |
| status still paused after /answer | B4 — sendEvent did not deliver / waitForEvent did not wake |

## Out of scope (later spikes)

- spike-3: sandbox carrier
- spike-4: third-party frontier model (anthropic) via OpenAI compat
- spike-5: Session API automatic compaction
- spike-6: AutoRAG per-tenant

## Run

```sh
cd ~/code/52/agentOS/spikes/02-suspendable-agent
bun install
bun run dev    # wrangler dev on :8787
# in another terminal:
bash ./test.sh
```

## Status

- [ ] code written
- [ ] runs locally
- [ ] writeup: which assumptions confirmed
