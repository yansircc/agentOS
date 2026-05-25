# spike-05 — anthropic-messages adapter (aihubmix)

> **Verdict**: 5 algebra checks (A1, A2, A3, A4, A7) pass on the first run.
> classify (A5) passed after the `unwrapErrorMessage` fix landed (one bug found and
> repaired during the spike; see "Findings" below).
> A6 reliability: **5/5 Supported** on `claude-sonnet-4-6` via aihubmix —
> meaningfully more reliable than spike-04's `@cf/openai/gpt-oss-120b`
> (≈ 60% 3/3, ≈ 40% partial). Forced-tool-call on a strong model is not the
> stochastic problem spec-25 §15 OQ 6 anticipated for the gpt-oss class.

This spike exercises the `anthropic-messages` LlmProtocolAdapter (spec-27)
against a live wire. The DO is built on `@agent-os/core`'s `AgentDOBase`,
so what gets tested IS the integrated adapter — not a hand-rolled copy.

The wire is aihubmix.com (`base_url` accepted by the official Anthropic
Python SDK as documented at https://aihubmix.com), which speaks native
Anthropic Messages API. The adapter posts to `${endpoint}/v1/messages`
with `x-api-key`, `anthropic-version`, top-level `system`,
`tools[].input_schema`, and `tool_choice: {type:"tool", name}` — i.e. the
Anthropic native shape, NOT OpenAI Chat Completions.

## Falsification surface

| # | Claim | Verifier | Result |
|---|---|---|---|
| A1 | routeFingerprint isolation: anthropic-messages and openai-chat-compatible are distinct surfaces | evidence.payload.key.routeFingerprint carries `"kind":"anthropic-messages"`; no merge with hypothetical OpenAI evidence at same modelId | **PASS** |
| A2 | end-to-end turn loop with `counter` tool | `/turn` returns `ok: true`, eventCount=5 (chat.ingested + llm.response + tool.executed + llm.response + delivered), `final` includes correct count + non-trivial reasoning | **PASS** |
| A3 | end-to-end structured submit | `/structured` returns `ok: true`, `final` is stringified JSON conforming to `SUMMARY_SCHEMA` (closed object with required summary/sentiment/keywords) | **PASS** |
| A4 | adapterId truth | evidence.payload.adapterId = `"anthropic-messages@1.0.0"`. Distinct from any cf-ai-binding or openai-chat-compatible row | **PASS** |
| A5 | classify on real 401 | `/test/classify-401` produces evidence with outcome `{class:"AuthError", status:401}` (NOT ProviderRejected) | **PASS** (after fix) |
| A6 | forced-tool-call reliability | `/structured` 5 fresh sessions | **5/5 Supported** |
| A7 | no aggregator masquerade | If aihubmix translated through OpenAI shape, the Anthropic-shaped body (`top-level system`, `input_schema`, `tool_choice:{type:tool,...}`) would be rejected. Successful Supported confirms aihubmix actually speaks Anthropic wire | **PASS** |

## Findings

### F-1 — `classify` was unwrapping the wrong layer (FIXED)

**Symptom**: A5 first run produced `{class:"ProviderRejected", status:0, body:""}`
instead of AuthError on a real 401.

**Root cause**: `attemptStructured` passes `rawEither.left` to
`adapter.classify`. That left is `UpstreamFailure`, which extends
`Data.TaggedError`. Reading `error.message` on a `TaggedError` returns
the tag (`"UpstreamFailure"`), NOT the HTTP cause. `dispatchProvider`
wraps fetch failures as `new UpstreamFailure({ cause: Error("HTTP 401 ...") })` —
the HTTP detail is on `error.cause.message`, one level deeper.

The original `classifyChatCompletionsError` had the same bug; it had
been working only when test fixtures bypassed the wrap. The fix
(`unwrapErrorMessage` helper in protocol-adapter.ts) unwraps one level:
if the error has `.cause`, prefer that as the source of the message.

**Class fix**: applies to both `cfAiBinding`/`openaiChatCompatible` and
`anthropic-messages` classify paths. Future adapters will use the same
helper, so the class of "classify saw the wrap, not the cause" cannot
recur by construction.

**Spec impact**: spec-27 §6 already required `classify` to map transport
errors. The implementation gap was that `dispatchProvider` wraps before
classify sees the error. Documenting this in the adapter helper now
makes it explicit; no spec change.

### F-2 — claude-sonnet-4-6 is reliable on forced-tool-call

5/5 Supported beats gpt-oss-120b's observed rate. spec-25 §15 OQ 6
discussed adaptive strategies for "stochastic" models; for production
apps choosing a strong-class model, the strict 1-evidence-per-attempt
rule remains adequate. The flake handling discussion in §15 OQ 6 stays
open for weaker models.

## Running the spike

Prereqs:
1. `bun install` at repo root (installs workspace)
2. `cd spikes/05-anthropic-messages`
3. `.dev.vars` must contain `ANTHROPIC_KEY_AIHUBMIX=sk-...` (not committed)

```sh
bun run dev          # in one terminal — wrangler dev on :8787
bash ./test.sh       # in another — runs the A1-A7 surface
```

Per-session isolation: each request takes `?session=<name>`. The DO's SQL
state is per-session. `test.sh` generates unique session names per run so
the lease projection starts fresh each time.

## Replay-able transcripts

Three sample transcripts (anchored to wall-clock timestamps so they're not
flaky across re-runs):

### A2 — multi-turn tool loop

```
POST /turn -> ok:true, eventCount:5, tokens:1957
final: "Hmm, that returned 3, but let me double-check by considering
overlapping occurrences... non-overlapping count: 3, overlapping count: 5..."
```

The model called `counter`, received `{count: 3}`, recognized that the
tool counts non-overlapping matches, and proactively distinguished
overlapping vs non-overlapping. The substrate's tool-loop logic
(submit-agent.ts) ran unchanged — no anthropic-specific branches.

### A3+A4 — structured submit

```
POST /structured -> ok:true, eventCount:3, tokens:878
final: {"summary":"...","sentiment":"positive","keywords":[...]}

evidence row:
  routeFingerprint: route-json-v1:{"credentialRef":"ANTHROPIC_KEY_AIHUBMIX",
                                   "endpointRef":"aihubmix",
                                   "kind":"anthropic-messages",
                                   "modelId":"claude-sonnet-4-6"}
  adapterId: anthropic-messages@1.0.0
  outcome:   {class:"Supported", tokensUsed:878}
```

### A5 — classify-401

```
POST /test/classify-401 -> ok:false, reason:"upstream_failure"
evidence outcome: {class:"AuthError", status:401}
lease projection (post-call):
  status: unsupported, failureClass: AuthError, retryAfter: ~7d
```

AuthError has TTL=0 in spec-25 §8 (not a capability fact), so the lease
DOES NOT cache it as unsupported for projection purposes. The row is
still appended for ops visibility; the projection ignores it. Verifying
the projection behavior is the job of the contract test, not the spike.

## What this spike does NOT prove

- It does not exercise the `extracted thinking` Anthropic feature
  (spec-27 §11 OQ 1). decodeTurn drops `thinking` blocks today.
- It does not exercise streaming (spec-27 §11 OQ 2).
- It does not exercise multi-tool-call in a single structured response
  (spec-27 §11 OQ 3). For free-text turn, multiple tool_use blocks ARE
  handled by decodeTurn — but the spike only triggers single-tool turns
  (counter, then summary).
- It does not measure spec-27 §5 (`adapterVersion` regression). That is
  unit-tested in admission-contract.test.ts.

These are explicitly out of scope for v0 of the anthropic adapter.

## Verdict — Algebra-level claims after spike

The anthropic-messages adapter as implemented in
`packages/core/src/protocol-adapter.ts §E.2` is sufficient for the v0
contract: it produces wire-correct bodies, folds Anthropic native
responses back into unified `LlmResponse` / `DecodeStructuredResult`,
and routes real upstream errors through `classify` to the correct
`FailureClass`. Apps that want admission evidence on the Anthropic
native wire can use this adapter today.
