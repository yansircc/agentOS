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

**What's validated (v0.2.12 — full fidelity):**

- ✅ Substrate wire end-to-end. `emitEvent` writes the ledger row AND fires
  the in-process `on()` handler synchronously. The handler's `submit()`
  call drives the agent loop. Tool dispatch logs `tool.executed` with the
  LLM's questions in `payload.args`. Loop terminates and `deliver` fires.

- ✅ Scope isolation (each session = one DO instance, ledger never
  crosses scopes — same SSoT discipline as spike-01-effect).

- ✅ Multi-turn shape. `on("interview.answer")` projects prior turns
  from the ledger and feeds them back as `context.priorTurns`.

- ✅ **Full Chinese SYSTEM_PROMPT, 0 directive intent**. With
  `route: { kind: "openai-chat-compatible", endpointRef: "openrouter",
  credentialRef: "OPENROUTER_KEY", modelId: "openai/gpt-4.1" }` and the
  v0.2.11 `system` field, the v0 dogfood produces valid Chinese
  multi-choice questions per the protocol's §必问路径 chain:

  - turn 1 → Experience identity question (你和 ROV 的关系…)
  - turn 2 (after mock answer) → customer/audience types question

  Exactly matches the original Vercel-AI-SDK Next.js app behavior, with
  ledger-as-SSoT replacing Vercel KV.

**Substrate findings surfaced (now ALL resolved):**

1. ~~`SubmitSpec` has no `system` field~~ **FIXED in v0.2.11 ([2b2c588]
   (../../packages/core/src/submit-agent.ts)).** Three-axis duality
   (system / intent / context) is properly separated.

2. ~~`callLlm` / `LlmResponseSchema` only accepts OpenAI Chat
   Completions response shape~~ **FIXED in v0.2.12 ([d0838b7](../../packages/core/src/llm.ts)).**
   `LlmRoute` is now a tagged union — `cf-ai-binding` plus
   `openai-chat-compatible` (BYOK via `ProviderRegistry` indirection).
   INV-8 revised: no ambient BYOK, but credentials are explicit route
   dependencies. Documented in spec-24 §6.3.

3. ~~Tool calling under heavy Chinese / long nested-schema prompts on
   gpt-oss-120b is unreliable~~ **Bypassed in v0.2.12** by routing to a
   stronger model (OpenRouter gpt-4.1) via the new adapter. The
   substrate makes this route swap a one-field change to
   `interview-do.ts`'s `ROUTE` constant — no app code restructure.

## How to run

```bash
# Prerequisite: write your OpenRouter API key into .dev.vars (gitignored).
# Get one at https://openrouter.ai/keys
cd /Users/yansir/code/52/agentOS/examples/insight-helper-agent
echo "OPENROUTER_KEY=sk-or-..." > .dev.vars

# Terminal 1: start the worker
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
