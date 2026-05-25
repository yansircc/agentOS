# spike-06 — gemini-generate-content adapter (Google direct)

> **Verdict**: All 7 algebra claims pass.  
> A6 reliability: **5/5 Supported** on `gemini-3.1-flash-lite`.  
> Three Gemini-specific wire quirks were discovered live and fixed in the adapter so the class of failure each represents cannot recur by construction.

This spike exercises the `gemini-generate-content` LlmProtocolAdapter
(spec-27 §6.4) against `https://generativelanguage.googleapis.com`.
The DO uses `@agent-os/core`'s `AgentDOBase` so the adapter code path
tested IS the integrated one.

## Falsification surface

| # | Claim | Result |
|---|---|---|
| A1 | routeFingerprint isolation — `gemini-generate-content` is a distinct capability surface, never aliased with other wires | **PASS** (evidence carries `"kind":"gemini-generate-content"`) |
| A2 | end-to-end turn loop with `counter` tool | **PASS** (after F-1 fix) — final answer correct, eventCount=5 |
| A3 | structured submit producing schema-conforming JSON | **PASS** (after F-2, F-3 fixes) |
| A4 | evidence.adapterId reads `gemini-generate-content@1.0.0` | **PASS** |
| A5 | classify on real bad credential | **PASS** (after F-4 fix) — `{class:"AuthError", status:400}` |
| A6 | forced-tool-call reliability | **5/5 Supported** |
| A7 | no aggregator masquerade — body posted is Gemini-native | **PASS** — successful Supported responses on `v1beta/models/...:generateContent` confirm |

## Findings — Gemini wire quirks discovered live

### F-1 — `thoughtSignature` round-trip is mandatory for gemini-3.1+ (FIXED)

**Symptom**: A2 first run produced `HTTP 400 INVALID_ARGUMENT:
"Function call is missing a thought_signature in functionCall parts."`
on turn 2 (after the tool result was sent back).

**Root cause**: gemini-3.1+ responses carry a `thoughtSignature` field
sibling to each `functionCall` part. When the conversation echoes that
assistant turn back on a subsequent request, the signature MUST be
re-emitted unchanged. Our initial `decodeGeminiTurn` dropped it.

**Fix** (`protocol-adapter.ts`):
- Extended `LlmToolCall` with `metadata?: Record<string, unknown>`
- `decodeGeminiTurn` captures `thoughtSignature` into
  `metadata.thoughtSignature`
- `encodeGeminiTurn` re-emits it when assembling a `functionCall` part
  for an assistant message

The metadata field is opaque to other adapters — they leave it alone.

### F-2 — Gemini's `parameters` doesn't accept `additionalProperties` (FIXED)

**Symptom**: A3 first run produced `HTTP 400 INVALID_ARGUMENT: "Unknown
name \"additionalProperties\" at 'tools[0].function_declarations[0].parameters'"`
classify correctly mapped this to `SchemaUnsupported` — but the class
of error was avoidable.

**Root cause**: Gemini accepts only a subset of JSON Schema in
`functionDeclarations[].parameters`. The substrate's `JsonSchemaObject`
supports `additionalProperties` (and `$schema`, `$id`, `$ref`); Gemini
rejects them.

**Fix** (`protocol-adapter.ts`):
- Added `sanitizeSchemaForGemini` that recursively strips
  `additionalProperties`, `$schema`, `$id`, `$ref`
- Called from `toolDefsToGemini` (turn tools) AND `encodeGeminiStructured`
  (forced-tool-call parameters)

The original schema (with `additionalProperties: false` if specified)
remains the SSoT — `schemaFingerprint` still hashes the full schema, and
the local `validateAgainstSchema` step still enforces closed-object
semantics after Gemini responds. Only the over-the-wire shape is
narrowed.

### F-3 — Gemini reports bad credentials as HTTP 400 INVALID_ARGUMENT (FIXED)

**Symptom**: A5 first run produced
`{class:"ProviderRejected", status:400, body:"API key not valid..."}`
instead of `AuthError`.

**Root cause**: Google's API returns HTTP 400 + `API_KEY_INVALID` or
`PERMISSION_DENIED` for credential failures, NOT the conventional HTTP
401. Without this special case, AuthError would silently route to
ProviderRejected — which has a 7-day TTL (lease-bearing!). Ops would
not be paged on the credential, and a routine cred rotation would not
heal the lease until manual invalidate.

**Fix** (`protocol-adapter.ts classifyGeminiError`):
- HTTP 400 + body contains `API_KEY_INVALID` / `PERMISSION_DENIED` /
  `api key not valid` → `AuthError`
- Branch is ordered BEFORE the generic 400 branch so the schema-error
  path doesn't shadow it

Two regression tests added in `gemini-adapter.test.ts` covering both
spellings of the auth signal.

### Combined impact

Three independent fixes, all at the adapter boundary — `LlmProtocolAdapter`'s
encapsulation paid off. The agent loop, the admission projection, and
the contract tests stayed completely unchanged. Only the Gemini-specific
wire translation evolved.

## Reliability — gemini-3.1-flash-lite vs spike-05's claude-sonnet-4-6

| Model | Wire | Forced-tool-call success rate |
|---|---|---|
| `@cf/openai/gpt-oss-120b` (spike-04) | cf-ai-binding | ≈ 60% 3/3 |
| `claude-sonnet-4-6` (spike-05) | anthropic-messages | 5/5 |
| `gemini-3.1-flash-lite` (this spike) | gemini-generate-content | 5/5 |

Two strong-class models hit perfect rates on the small-sample test. The
"stochastic strategy" discussion in spec-25 §15 OQ 6 was driven by
gpt-oss-120b; it does not appear to generalize across protocols.

## Running

Prereqs:
1. `bun install` at repo root
2. `cd spikes/06-gemini-generate-content`
3. `.dev.vars` with `GEMINI_KEY=AIzaSy...` (not committed)

```sh
bun run dev          # terminal 1 — wrangler dev on :8787
bash ./test.sh       # terminal 2 — A1-A7 surface
```

## What this spike does NOT prove

- It does not exercise streaming.
- It does not exercise multi-tool-call returning multiple functionCalls
  in one structured response (spec-27 §11 OQ 3 — strictness asymmetry).
- It does not exercise long-context behavior.

These are out of scope for v0 of the gemini adapter.

## Verdict

The `gemini-generate-content` adapter as implemented in
`packages/core/src/protocol-adapter.ts §E.3` plus the three live-discovered
wire quirks (F-1/F-2/F-3, all class-eliminating fixes) is sufficient for
the v0 contract.

Combined with spike-05 (anthropic-messages), spec-27's
"finite protocol adapters × infinite routes/models × evidence-derived
capability" algebra is validated on three live wires:
`cf-ai-binding` (spike-04), `anthropic-messages` (spike-05), and
`gemini-generate-content` (spike-06). Apps choose `route.kind` based on
which capability surface they want admission evidence on; the substrate
layer is wire-agnostic above the adapter.
