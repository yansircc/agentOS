# insight-helper-agent (v0 dogfood)

Backend-only rewrite of [`/Users/yansir/code/52/insight-helper`](/Users/yansir/code/52/insight-helper)
on top of `@agent-os/core`. Demonstrates the substrate's full reactive
triad (`emitEvent` × `on` × `submit`) carrying a real multi-turn
interview pattern. The Next.js frontend in the original repo is NOT
touched in v0; this example is HTTP-only, validated via `curl` /
`test.sh`.

## Architecture (one file per concern, ~325 LOC total)

```
worker.ts            HTTP entry (POST /start | POST /answer | GET /events/:scope)
                     Routes to InterviewDO via env.INTERVIEW_DO.idFromName(sessionId).

interview-do.ts      InterviewDO extends AgentDOBase. constructor wires
                     on("interview.start") and on("interview.answer") — both
                     handlers reconstruct context from the ledger and call
                     submit() with the same shape (only priorTurns differs).

interview-tool.ts    `interview` tool definition. JSON Schema parameters +
                     Tool with pass-through-ish execute (returns a "stop now"
                     hint to the LLM so it doesn't re-emit questions in text).

system-prompt.ts     Two prompts: the FULL ~4000-char Chinese SYSTEM_PROMPT
                     ported verbatim from the original app, AND a COMPACT
                     English-bias variant. Neither is currently used by
                     interview-do.ts (which uses an inline directive intent
                     for v0 — see "Status & limitations" below).
```

## Reactive flow

```
POST /start  {sessionId, topic, businessContext?}
   ↓
   stub.emitEvent("interview.start", {topic, businessContext})
   ↓  (Ledger.log + EventBus.fire, synchronous)
   on("interview.start") handler fires
   ↓
   submit({intent, context: {topic, priorTurns: []}, tools: {interview}, ...})
   ↓
   LLM calls `interview` tool with questions
   ↓
   tool.executed ledger event (payload.args = the questions)
   ↓
   loop terminates
   ↓
   interview.turn.delivered event fires (payload.final = LLM's closing text)

POST /answer {sessionId, answers}
   ↓ same shape; priorTurns is now populated from ledger projection

GET /events/:sessionId
   ↓ returns the whole ledger; frontend reads the latest tool.executed
     for current questions, and interview.turn.delivered for the final brief.
```

## Status & limitations

**What's validated:**

- ✅ Substrate wire end-to-end. `emitEvent` writes the ledger row AND fires
  the in-process `on()` handler synchronously. The handler's `submit()`
  call drives the agent loop. Tool dispatch logs `tool.executed` with the
  LLM's questions in `payload.args`. Loop terminates and `deliver` fires.
  All observable in `GET /events/:sessionId` after one `POST /start`.

- ✅ Scope isolation (each session = one DO instance, ledger never
  crosses scopes — same SSoT discipline as spike-01-effect).

- ✅ Multi-turn shape. `on("interview.answer")` projects prior turns
  from the ledger and feeds them back as `context.priorTurns`.

**What's NOT validated, and why:**

- ❌ End-to-end interview fidelity using the original Chinese
  `SYSTEM_PROMPT`. Workers AI `@cf/openai/gpt-oss-120b` (the only
  Workers AI model that returns OpenAI Chat Completions response shape
  AND supports tool calling) is a reasoning model. Given the full
  ~4000-char Chinese protocol it emits 256 reasoning tokens with
  empty `choices[0].message.content` and zero `tool_calls`. The model
  is the bottleneck; the substrate is correct (proven by reducing to a
  directive intent — tool call fires every time).

  The current `interview-do.ts` uses a directive intent ("Call the
  `interview` tool NOW with N questions in Chinese …") that gpt-oss-120b
  handles correctly. This is degraded fidelity vs the original prompt
  but proves substrate-carries-pattern.

- ❌ Final-brief generation across N turns. Not exercised here because
  the smaller-prompt path doesn't carry the EEAT discipline of the
  full prompt — measuring brief quality would be measuring the wrong
  thing on the wrong model.

**Substrate findings surfaced by this dogfood:**

1. ~~`SubmitSpec` has no `system` field~~ **FIXED in v0.2.11
   ([2b2c588](../../packages/core/src/submit-agent.ts)).** The current
   `interview-do.ts` now uses `submit({system: SYSTEM_PROMPT, intent:
   "Start the interview now…", context: {...}})` — the three-axis duality
   (system / intent / context) is properly separated.

   Empirical follow-up: with the field properly used, prompt tokens
   dropped from ~3460 (duplicated) to ~1933 (system only). LLM behavior
   on `gpt-oss-120b` was UNCHANGED — still 256 reasoning tokens with
   empty content + zero tool_calls. **Prompt-duplication was not the
   bottleneck**; model capability is. Recorded so future contributors
   don't relitigate.

2. `callLlm` / `LlmResponseSchema` only accepts OpenAI Chat
   Completions response shape (`{choices: [...]}`). Workers AI native
   models (e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) return
   `{response: ...}` and are rejected as `agent.aborted.upstream_failure`.
   Documented in
   [notes/structured-output-exploration.md](../../docs/notes/structured-output-exploration.md);
   **slated for v0.2.12** as the LLM protocol adapter — parallel to
   spec-25's structured-output adapters — which generalizes callLlm to
   route → encode/decode/classify. First useful adapter target = the
   strong model that unlocks the full SYSTEM_PROMPT path.

3. Tool calling under heavy Chinese / long nested-schema prompts on
   `gpt-oss-120b` is unreliable even when the wire and message shapes
   are correct. This is an upstream model concern, confirmed by the
   v0.2.11 follow-up test above. Production path: route to a stronger
   model (claude / gpt-4 class) via `@cf/anthropic` (once Cloudflare
   ships it) or AI Gateway with BYOK.

## How to run

```bash
# Terminal 1: start the worker
cd /Users/yansir/code/52/agentOS/examples/insight-helper-agent
bunx wrangler dev

# Terminal 2: send a start event
curl -X POST http://localhost:8787/start \
  -H 'content-type: application/json' \
  -d '{"sessionId":"demo-1","topic":"How long can ROVs stay underwater?"}'

# Watch the ledger fill in (Cloudflare AI binding takes ~5-30s):
curl http://localhost:8787/events/demo-1 | jq

# When you see a tool.executed event with name=interview, parse its
# payload.args.questions and POST an answer:
curl -X POST http://localhost:8787/answer \
  -H 'content-type: application/json' \
  -d '{"sessionId":"demo-1","answers":{"你和 ROV 的关系是什么？":"ROV 产品外贸从业者"}}'
```

`test.sh` automates the above with polling. It is a **model-dependent
smoke test** — if Workers AI changes behavior or the LLM produces
unexpected output, individual assertions may fail; the substrate
itself remains validated by the contract tests in `packages/core/test/`.

## What this proves about agent-OS

The substrate's full public surface — `emitEvent`, `on`, `submit`,
`events`, `scheduleEvent` — composes naturally for the interview
pattern with **zero substrate changes**. Adding a real app would:

- ~120 LOC of app code (this directory minus the system prompt
  constant, which is app-domain data not infrastructure)
- 0 LOC of substrate adaptation

For comparison, the original Next.js implementation's backend is
`src/app/api/chat/route.ts` at 200 LOC (50 LOC code, 150 LOC of the
same system prompt). The architectural win isn't LOC (it's flat — see
prediction in branch description) but **ledger as SSoT**: each
interview session's full event log lives in DO SQLite, replayable,
auditable, debuggable from `GET /events/:scope` without any extra
infrastructure.
