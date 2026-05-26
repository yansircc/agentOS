# Spec 27: LLM Protocol Adapter Algebra

> **Status**: Draft v0 (drafted 2026-05-25)
> **Extends**: [spec-25-llm-admission.md](./spec-25-llm-admission.md) §6 (Adapter law) and §11 (Enabled subset)
> **Originates from**: Codex review 2026-05-25 — "do not extend admission only; elevate LLM layer into protocol adapter algebra"
> **Does not change**: spec-25 §7 (`attemptStructured` algorithm), §8 (FailureClass/TTL), §9 (adapterVersion semantics), §10 (admissionImpact)

---

## 0. Purpose

spec-25 introduced an `Adapter` only for the structured-output path:
`(encode, decode, classify)` consumed by `attemptStructured`. The free-text
agent turn / multi-turn tool loop (`callLlm` in `packages/core/src/llm.ts`)
still decodes through a hard-coded `LlmResponseSchema` whose shape is OpenAI
Chat Completions. This only works for routes whose wire happens to be Chat
Completions — `cf-ai-binding` (Workers AI's OpenAI compat layer) and
`openai-chat-compatible`. Adding `anthropic-messages` or
`gemini-generate-content` breaks `callLlm` immediately: the response is not
`{choices: [{message: {content, tool_calls}}]}`, so decode fails before any
business logic runs.

This spec elevates LLM protocol handling into a **single unified
`LlmProtocolAdapter` algebra**: one adapter per `LlmRoute["kind"]`, covering
both turn semantics (free-text agent loop) and structured semantics
(admission). `callLlm` and `attemptStructured` share the same adapter
registry, the same `dispatchProvider` transport, the same `classify` rules.

Adding a new wire = adding one adapter, not patching two surfaces.

---

## 1. Invariant

> **Core knows finite wire protocols, not infinite models. Every
> interaction with a route — turn or structured — goes through the same
> protocol adapter. Different wire = different adapter = different
> capability surface. No protocol-level fallback.**

```
finite protocol adapters × infinite routes/models × evidence-derived capability
```

Corollaries:

- **C-1**. Each `LlmRoute["kind"]` has exactly one `LlmProtocolAdapter`. No
  partial / half adapters. Registering a `kind` is an atomic act covering
  both turn and structured halves.
- **C-2**. `callLlm` (turn) and `attemptStructured` (structured) MUST consume
  the same adapter for the same `route.kind`. A route's turn behavior and
  structured behavior are evidence about the *same* wire; allowing two code
  paths to handle the wire would let one corner regress invisibly.
- **C-3**. `openai-chat-compatible` (any endpoint speaking Chat Completions
  JSON) and `anthropic-messages` (Anthropic native Messages API) are NOT
  interchangeable substitutes for each other, even when both end up calling
  the "same" upstream model (e.g. Claude via an aggregator). They are
  **distinct capability surfaces** with distinct `routeFingerprint`, distinct
  `classify` rules, distinct TTL gradients. Apps choose explicitly. Core
  never silently translates between them.

### 1.1 Correction relative to spec-25 v0 framing

spec-25 v0 implicitly suggested that "going through an OpenAI-shape
aggregator is wrong because routeFingerprint would lie". That framing was
tightened during the spec-27 review cycle:

A route declared as
`{kind: "openai-chat-compatible", endpointRef: "openrouter", modelId: "anthropic/..."}`
**does not lie**. The fingerprint honestly represents "OpenRouter's
Chat-Completions-shaped wire serving this modelId". Evidence collected on
that route attributes truthfully to that wire.

What it **cannot do**: stand in for
`{kind: "anthropic-messages", endpointRef: "anthropic", modelId: "..."}`.
These are two different capability surfaces. They produce different evidence
streams, different lease projections, different operational TTLs. An app
that wants Anthropic-native admission evidence MUST use the
`anthropic-messages` route — going via an OpenAI-shape aggregator yields
evidence about the aggregator, not about Anthropic.

Both routes are first-class. Apps choose based on what capability question
they want admission to answer.

---

## 2. Scope correction relative to spec-25

| spec-25 element | spec-27 change | Reason |
|---|---|---|
| §6 `Adapter` interface | **Renamed** to `LlmProtocolAdapter`. `encode/decode` become `encodeStructured/decodeStructured`. Two new methods `encodeTurn/decodeTurn`. `classify` unchanged. | Free-text turn must go through the same per-wire algebra; otherwise adding a new wire breaks `callLlm`. |
| §11 "Enabled subset" | **Subsumed** by adapter registry. Registration of a `kind` enables it. No separate enablement list. | Single source of truth for "which protocols core can speak". |
| §7 `attemptStructured` algorithm | **Unchanged**. Step 4 (encode) and step 6 (decode) now call `adapter.encodeStructured` / `adapter.decodeStructured` instead of `adapter.encode` / `adapter.decode`. | Method renames are mechanical. Algorithm is invariant. |
| §8 FailureClass + TTL | **Unchanged**. Same classify output, same lease projection. | classify is shared between turn and structured. |
| §9 adapterVersion | **Tightened** (see §5 below). | Single coherence dial across both halves of the adapter. |
| §10 admissionImpact | **Unchanged**. Turn calls do not produce evidence and so do not have an admissionImpact field. | Structured path's lease semantics intact. |

No spec-25 invariant changes. spec-27 is a layer above, not a rewrite.

---

## 3. `LlmProtocolAdapter` interface

```ts
interface LlmProtocolAdapter<K extends LlmRoute["kind"]> {
  readonly kind: K;
  readonly version: SemverString;       // governs admission lease per spec-25 §9 + §5 below

  // ──── Free-text agent turn ────────────────────────────────────────
  encodeTurn(
    route:   Extract<LlmRoute, { kind: K }>,
    request: TurnRequest,               // { messages, tools?, tool_choice? }
  ): ProviderRequestBodyFor<K>;

  decodeTurn(
    raw: unknown,
  ): TurnResponse;                       // { text, toolCalls[], usage }

  // ──── Structured-output admission ─────────────────────────────────
  encodeStructured(
    route:    Extract<LlmRoute, { kind: K }>,
    schema:   SchemaContract,
    stimulus: Stimulus,
    strategy: Strategy,
  ): ProviderRequestBodyFor<K>;

  decodeStructured(
    raw:      unknown,
    schema:   SchemaContract,
    strategy: Strategy,
  ): { ok: true; decoded: unknown } | { ok: false; outcome: Outcome };

  // ──── Shared by both halves ───────────────────────────────────────
  classify(error: unknown): Outcome;    // HTTP / transport / protocol-level errors
}
```

### 3.0.1 `classify` runtime scope — interface vs callers

`classify` is interface-shared (one function on the adapter, callable
from either half). **In v0 the only runtime consumer is
`attemptStructured`** — its `outcome` lands in evidence and drives lease
projection.

`callLlm` (free-text turn) does **not** invoke `classify` in v0.
Dispatch failures surface as raw `UpstreamFailure { cause }`, which
`submit-agent` already funnels through its `agent.aborted.upstream_failure`
abort taxonomy. There is no `FailureClass`-aware retry on the turn path;
transient HTTP errors become upstream aborts.

This is a scope decision, not an interface gap. The function lives on
the adapter so per-wire classification is available; the runtime gates
which half consumes it. See §11 OQ 6 for the future typed-turn-failure
design that would route turn errors through `classify` to drive
adaptive retry.

### 3.1 Per-kind `ProviderRequestBodyFor<K>`

`ProviderRequestBody` is **per-wire**, not a single shared shape. The
generic parameter `K` constrains which body shape each adapter emits and
which body shape `dispatchProvider` expects.

- `cf-ai-binding` + `openai-chat-compatible` happen to share the Chat
  Completions body, so their `ProviderRequestBodyFor<K>` is structurally
  identical (no degenerate inheritance — they're just two adapters that
  produce isomorphic bodies).
- `anthropic-messages` has its own body shape (`{system, messages, tools[],
  tool_choice, max_tokens, ...}`).
- `gemini-generate-content` has its own body shape (`{systemInstruction,
  contents, tools[], toolConfig, generationConfig?, ...}`).

This was deliberated against the alternative "ProviderRequestBody is a
single neutral shape, `dispatchProvider` re-shapes per wire". Rejected:
that would push protocol translation into the transport layer, mixing two
concerns. The adapter exists precisely to own protocol translation. The
dispatcher owns transport (URL, headers, body serialization, error
propagation) and nothing else.

### 3.2 Adapter purity

Adapters are pure. They have no IO, no clock, no secret resolution. Secrets
(via `credentialRef`) are resolved by `dispatchProvider` from
`ProviderRegistry`. The adapter does not see the secret value.

`encodeTurn` / `encodeStructured` are total functions: route + request →
body. `decodeTurn` / `decodeStructured` accept the raw `unknown` upstream
response. They MAY throw on protocol-level malformedness (`decodeTurn`) or
return an `Outcome` ADT (`decodeStructured` — must distinguish
BehaviorFailed from network error). `classify` is total over `unknown`
errors.

---

## 4. Turn vs Structured asymmetry

The two halves share interface and adapter version. They diverge in
semantics:

| Dimension | Turn | Structured |
|---|---|---|
| Caller | `callLlm` → `submit-agent.ts` free-text loop, future direct app callers | `attemptStructured` (admission.ts) |
| Admission evidence | none (no `schemaFingerprint`; turn has no capability claim) | written to `llm.structured.evidence` |
| Lease projection | n/a | per spec-25 §7.2 |
| Strictness | permissive: zero tool calls in response is valid (assistant chose to text-respond, or text + tool mix) | strict: forced tool call MUST be present and exactly one; missing / extra / wrong name = `BehaviorFailed` |
| Output shape | `LlmResponse { text, toolCalls[], usage }` — unified across wires | `{ ok, decoded } | { ok: false, outcome }` |
| `tool_choice` value | optional; supplied by caller | always set by the adapter to force the synthesized `_submit_structured` tool |
| `classify` consumption | **v0: not invoked.** dispatch errors propagate as raw `UpstreamFailure`; `submit-agent`'s abort taxonomy handles them. See §3.0.1 + §11 OQ 6. | yes (HTTP error → outcome row in ledger) |
| `adapterVersion` governance | shared; bump signals turn decode rule change | shared; bump invalidates structured lease per §5 |

**Strictness asymmetry is the only semantic divergence.** Everything else
flows from "where does the call originate and what does it commit to the
ledger". `decodeTurn` and `decodeStructured` can share helpers (e.g.
"normalize tool_use blocks into unified `LlmToolCall` shape") but their
post-conditions differ.

---

## 5. `adapterVersion` semantics (tightened)

spec-25 §9 says major bump invalidates lease evidence. spec-27 tightens
when a major bump is required:

- **Encoding rule change on EITHER half** (turn or structured) → major bump.
- **Decode rule change on `decodeStructured`** → major bump (spec-25 §9
  already mandates this).
- **Decode rule change on `decodeTurn`** → major bump. There is no lease
  evidence to invalidate, but `adapterVersion` is a single coherence dial
  across the whole adapter. Bumping it preserves the invariant "evidence
  recorded at adapterVersion V was produced by V's complete code".
- **`classify` rule change** → major bump. classify is shared between
  halves; any change affects both turn and structured outcome computation.

In short: **any observable behavior change in the adapter → major bump**.
This is more conservative than spec-25 §9's "encoding/decoding behavior
changes" wording. Cost is zero (a one-time re-admission per route after a
release). Upside: `adapterVersion` is a real coherence dial — evidence is
either entirely under V or entirely under V+1, never half.

### 5.1 What does NOT require a major bump

- Type signature refactors with no observable wire change
- Internal helper extraction
- Comment-only changes
- Telemetry / logging additions that do not affect request body or response
  parsing

These may bump minor or patch.

---

## 6. Protocol wire shapes

For each registered `kind`, this section pins the wire-level decisions.
Tests in §9.1 verify each row.

### 6.1 `cf-ai-binding` (existing)

- Transport: `env.AI.run(modelId, body)` (Workers AI binding)
- Body: Chat Completions shape
- Turn forced-tool-call: `tool_choice: {type: "function", function: {name}}`
- Turn decode: `choices[0].message.{content, tool_calls[]}`; `tool_calls[].function.arguments` is a **JSON string** (requires `JSON.parse`)
- Structured: same body as turn, with adapter-synthesized `_submit_structured` tool
- classify: HTTP-status-keyword heuristic from `cause.message` (existing implementation)

### 6.2 `openai-chat-compatible` (existing)

- Transport: `fetch(${endpoint}/chat/completions, { Authorization: "Bearer <cred>", body: {model: modelId, ...body} })`
- Body / decode / classify: identical to `cf-ai-binding` (same Chat
  Completions wire). The two adapters share pure functions for
  `encodeTurn / decodeTurn / encodeStructured / decodeStructured / classify`;
  they differ ONLY in the `dispatchProvider` branch they trigger.
- Registered as a separate adapter so `routeFingerprint` and `adapterId`
  stay distinct per spec-25 §11.

### 6.3 `anthropic-messages` (new)

- Transport: `fetch(${endpoint}/v1/messages, { headers: {x-api-key: cred, anthropic-version: route.anthropicVersion ?? "2023-06-01", content-type: "application/json"}, body: {...} })`
- Auth header: `x-api-key` (NOT `Authorization: Bearer`)
- Version header: `anthropic-version` is required by Anthropic. Default
  `"2023-06-01"`. Routes may pin via optional `anthropicVersion` field.
- Body shape:
  ```jsonc
  {
    "model":       "<modelId>",
    "max_tokens":  16000,                  // required by Anthropic
    "system":      "<concat'd system msgs>", // top-level string, NOT in messages[]
    "messages":    [{ "role": "user"|"assistant", "content": "..." }, ...],
    "tools":       [{ "name", "description", "input_schema": <JSON Schema> }],
    "tool_choice": { "type": "tool", "name": "..." }   // for forced
  }
  ```
  - System messages: extracted from `request.messages` (which uses unified
    role tagging) and concatenated into the top-level `system` field. There
    is no `role: "system"` in Anthropic's `messages[]`.
  - Tool schema location: `tools[].input_schema` (NOT
    `tools[].function.parameters`).
  - Forced tool call: `tool_choice: {type: "tool", name}`.
- Turn decode:
  - Response: `{content: [{type, ...}, ...], stop_reason, usage: {input_tokens, output_tokens}}`
  - For each block:
    - `{type: "text", text}` → concat into `LlmResponse.text`
    - `{type: "tool_use", id, name, input}` → normalize into unified
      `LlmToolCall { id, type: "function", function: { name, arguments: JSON.stringify(input) } }`. `input` is **already an object**;
      stringifying it back so submit-agent's tool-loop code (which currently expects `arguments: string`) stays protocol-agnostic.
  - usage normalization: `{promptTokens: input_tokens, completionTokens: output_tokens, totalTokens: input_tokens + output_tokens}`
- Structured decode:
  - Same as turn decode, then assert: exactly one `tool_use` block, name
    matches the forced tool name. Else `{ok: false, outcome: BehaviorFailed}`.
  - Validate `input` (the already-parsed object) against the schema. Schema
    violation → `BehaviorFailed`.
- classify:
  - HTTP 401 / 403 → `AuthError`
  - HTTP 429 → `RateLimited` (parse `retry-after` if present)
  - HTTP 400 with `error.type == "invalid_request_error"` and message
    mentions `schema` / `tool` / `input_schema` → `SchemaUnsupported`
  - HTTP 400 other → `ProviderRejected`
  - HTTP 529 ("overloaded") → `TransientError`
  - HTTP 5xx → `TransientError`
  - Network / fetch reject → `TransientError`

aihubmix.com is wire-compatible (the official Anthropic Python SDK works
against `base_url="https://aihubmix.com"`). It is a valid `endpointRef`
for the `anthropic-messages` route. Treated identically to
`api.anthropic.com` — same protocol adapter, different `endpointRef`,
distinct `routeFingerprint`.

### 6.4 `gemini-generate-content` (new)

- Transport: `fetch(${endpoint}/v1beta/models/${modelId}:generateContent, { headers: {x-goog-api-key: cred, content-type: "application/json"}, body: {...} })`
- Auth: `x-goog-api-key` header (alternatively `?key=` query; header
  preferred for not leaking into URLs / logs).
- Body shape:
  ```jsonc
  {
    "systemInstruction": { "parts": [{ "text": "<system>" }] },  // top-level
    "contents":          [{ "role": "user"|"model", "parts": [{ "text" } | { "functionCall": {name, args} } | { "functionResponse": {name, response} }] }],
    "tools":             [{ "functionDeclarations": [{ "name", "description", "parameters": <JSON Schema> }] }],
    "toolConfig":        { "functionCallingConfig": { "mode": "ANY", "allowedFunctionNames": ["..."] } }  // for forced
  }
  ```
  - Role names: `"user"` and `"model"` (NOT `"assistant"`).
  - System: top-level `systemInstruction`. There is no `role: "system"` in
    `contents[]`.
  - Tools wrapping: `tools[].functionDeclarations[]` (an array of arrays —
    the outer is "tool group", inner is "function declarations within
    group"). For v0, emit a single tool group containing all declarations.
  - Forced tool: `toolConfig.functionCallingConfig.mode = "ANY"` plus
    `allowedFunctionNames: ["<single name>"]` ≡ forced single tool.
- Turn decode:
  - Response: `{candidates: [{content: {parts: [...], role}, finishReason, ...}], usageMetadata: {promptTokenCount, candidatesTokenCount, totalTokenCount}}`
  - For each part in `candidates[0].content.parts`:
    - `{text}` → concat into `LlmResponse.text`
    - `{functionCall: {name, args}}` → normalize into unified `LlmToolCall { id: synthesizeId(), type: "function", function: { name, arguments: JSON.stringify(args) } }`. `args` is **already an object**.
  - usage normalization: `{promptTokens: promptTokenCount, completionTokens: candidatesTokenCount, totalTokens: totalTokenCount}`
- Structured decode:
  - Same as turn decode, then assert exactly one `functionCall` with
    matching name. Validate `args` against schema. Else `BehaviorFailed`.
- classify:
  - HTTP 400 with body `error.status == "INVALID_ARGUMENT"` and message
    mentions schema / parameter → `SchemaUnsupported`
  - HTTP 400 other → `ProviderRejected`
  - HTTP 401 / 403 → `AuthError`
  - HTTP 429 (`RESOURCE_EXHAUSTED`) → `RateLimited`
  - HTTP 503 (`UNAVAILABLE`) → `TransientError`
  - HTTP 5xx → `TransientError`
  - Network / fetch reject → `TransientError`

---

## 7. Route additions

`LlmRoute` tagged union (extends spec-25 §3):

```ts
type LlmRoute =
  | { kind: "cf-ai-binding";              modelId: string; gatewayRef?: string }
  | { kind: "openai-chat-compatible";     endpointRef: string; credentialRef: string; modelId: string }
  | { kind: "anthropic-messages";         endpointRef: string; credentialRef: string; modelId: string; anthropicVersion?: string }
  | { kind: "gemini-generate-content";    endpointRef: string; credentialRef: string; modelId: string };
```

Notes:

- `anthropicVersion` is optional on the public route shape. The
  **effective** value (pinned route value, or the substrate's current
  default if omitted) is injected into `routeFingerprint` BEFORE
  canonical JSON via `normalizeRouteForFingerprint`. Pinned routes and
  unpinned routes against the same current default share the same
  fingerprint; unpinned routes against different default values do
  NOT.

  Rationale (corrected by Codex 2026-05-26): a different Anthropic API
  version is a different wire surface (different feature set, different
  error semantics). Capability evidence collected under version V must
  NOT roll forward to version V+1 — that would project a lease across a
  capability boundary. The earlier draft argued "default bumps should
  not invalidate unpinned routes because they asked for 'whatever
  current is'"; that reading violated the spec-25 invariant. The fix is
  normalization at the fingerprint boundary: bumping
  `LLM_DEFAULTS.anthropicVersion` in core invalidates all unpinned
  anthropic-messages leases by construction, forcing re-admission
  against the new wire.

- `openai-responses` from spec-25 §3 is **not** registered in this spec.
  Its decode shape differs from Chat Completions (Responses API has its
  own response envelope). When an app needs it, a separate adapter
  registration adds it.

---

## 8. `dispatchProvider` unification

`dispatchProvider(route, body)` is the single transport seam. It does NOT
know about turn vs structured — both pass the same per-kind
`ProviderRequestBodyFor<K>` through:

```ts
const dispatchProvider = <K extends LlmRoute["kind"]>(
  route: Extract<LlmRoute, { kind: K }>,
  body:  ProviderRequestBodyFor<K>,
): Effect.Effect<
  unknown,                                                // raw upstream response
  UpstreamFailure | EndpointNotFound | CredentialNotFound,
  AiBinding | ProviderRegistry
> => {
  switch (route.kind) {
    case "cf-ai-binding":             return env.AI.run(route.modelId, body);
    case "openai-chat-compatible":    return fetch chat-completions(...);
    case "anthropic-messages":        return fetch v1/messages(...);
    case "gemini-generate-content":   return fetch v1beta/...:generateContent(...);
  }
};
```

`callLlm`:

```ts
const callLlm = (route, request) =>
  Effect.gen(function* () {
    const adapter = registry[route.kind];
    const body    = adapter.encodeTurn(route, request);
    const raw     = yield* dispatchProvider(route, body);
    return adapter.decodeTurn(raw);                       // returns LlmResponse
  });
```

`attemptStructured` (spec-25 §7.1 algorithm, with method renames):

```ts
attemptStructured:
  ...step 4: providerRequest = adapter.encodeStructured(route, schema, stimulus, strategy)
  ...step 5: providerResponse = dispatchProvider(route, providerRequest)
  ...step 6: result = adapter.decodeStructured(providerResponse, schema, strategy)
  ...
```

Both callers feed `dispatchProvider` with a body the wire understands. The
dispatcher is mechanical — no protocol knowledge beyond URL / headers /
body shape per kind.

---

## 9. Acceptance criteria

Each protocol adapter MUST pass:

### 9.1 Three-layer adapter contract tests (unit, no network)

For each `kind`:

1. **encode shape** — encodeTurn / encodeStructured produce a body that:
   - locates `system` / `messages` / `contents` correctly per wire
   - locates `tools` schema correctly (`function.parameters` vs
     `input_schema` vs `functionDeclarations.parameters`)
   - sets `tool_choice` / `toolConfig` correctly for forced
   - uses the correct auth header convention (verified in dispatchProvider
     test, since auth is a transport concern, not adapter — but the test
     proves the wire-level decision)

2. **decode shape** — decodeTurn folds native tool-call blocks
   (`tool_calls[]` / `content[].tool_use` / `parts[].functionCall`) into
   unified `LlmResponse { text, toolCalls[], usage }`. decodeStructured
   enforces strictness (exactly one matching forced tool call; schema
   violation → BehaviorFailed).

3. **classify** — fixture HTTP errors map to the correct `FailureClass`:
   401/403 → AuthError, 429 → RateLimited, 400-schema → SchemaUnsupported,
   400-other → ProviderRejected, 5xx / 529 → TransientError, network
   errors → TransientError.

### 9.2 Cross-wire integration test

Same app prompt with the same `outputSchema`:

```ts
const prompt = "Plan a 3-day trip to Tokyo. Output as itinerary.";
const schema = { /* itinerary JSON Schema */ };

// Run on three routes:
await agent.submit({ ..., agent: { route: {kind: "openai-chat-compatible", ...}}, outputSchema: schema })
await agent.submit({ ..., agent: { route: {kind: "anthropic-messages", ...}},    outputSchema: schema })
await agent.submit({ ..., agent: { route: {kind: "gemini-generate-content", ...}}, outputSchema: schema })
```

Each call produces an evidence row with its own `routeFingerprint` (and
hence its own lease). All three deliver the structured payload to the
same `deliver.event` handler. No protocol-level fallback occurs.

Symmetric turn test:

```ts
const prompt = "Use the tool 'lookup_city' to find facts about Tokyo, then summarize.";
await agent.submit({ ..., agent: { route: ... }, tools: { lookup_city: ... } })
```

Each route MUST execute the multi-turn tool loop without protocol
adaptation in the loop code itself — all wire shaping is in the adapter.

### 9.3 Adapter version regression test

Bump `cfAiBindingAdapter.version` (1.0.0 → 2.0.0). Existing evidence at 1.x
is filtered by `projectLease` (per spec-25 §9). Add anthropic/gemini
adapters with `version: "1.0.0"` — their evidence is isolated by
`(routeFingerprint, adapterVersion)`; cf bump does not affect them.

### 9.4 Real-provider validation per wire

- **Anthropic Messages**: `anthropic-messages` against aihubmix. Validates §6.3 row
  by row on a live wire. Includes turn-loop tool call + structured
  outputSchema in one test app.
- **Gemini Generate Content**: `gemini-generate-content` against official Google. Same
  validation for §6.4.

Both validations follow the spec-25 falsification surface convention
(A1–A7-style algebra checks). Secrets in untracked `.dev.vars`.

---

## 10. Migration plan

Non-breaking sequence (all internal; no public RPC change):

1. **Define `LlmProtocolAdapter<K>` interface** in
   `packages/core/src/llm.ts`. Add `ProviderRequestBodyFor<K>` mapped type.
   No behavior change yet.

2. **Refactor existing 2 adapters** to the new interface:
   - `cfAiBindingAdapter`: implement `encodeTurn` (extracted from current
     `callLlm` body-shaping in llm.ts), `decodeTurn` (extracted from
     current `decodeResponse`), `encodeStructured` (rename of current
     `encodeChatCompletionsForced`), `decodeStructured` (rename of current
     `decodeChatCompletionsForced`), `classify` (rename of current
     `classifyChatCompletionsError`).
   - `openaiChatCompatibleAdapter`: structurally identical pure
     functions; just a different `kind` tag.
   - `dispatchProvider` unchanged.
   - `callLlm` rewritten to: `adapter.encodeTurn → dispatchProvider →
     adapter.decodeTurn`.
   - `attemptStructured` (admission.ts) updated to call
     `adapter.encodeStructured / decodeStructured`. Internal only —
     external callers unaffected.

3. **All existing tests pass without modification.** Method renames
   confined to internal call sites.

4. **Add `anthropic-messages` adapter** + dispatch branch. Adapter contract
   tests (§9.1) plus live-wire validation.

5. **Add `gemini-generate-content` adapter** + dispatch branch. Adapter
   contract tests plus live-wire validation.

Each step is its own commit. `adapterVersion` for the migrated
cf-ai-binding stays `"1.0.0"` since behavior is identical (per §5.1
"refactors with no observable wire change do not bump").

---

## 11. Open questions

1. **Anthropic extended thinking blocks.** Anthropic's response may include
   `{type: "thinking", thinking}` blocks when `thinking: {type: "enabled"}`
   is set on the request. v0 of the adapter ignores them (drops on the
   floor in decodeTurn). When an app wants to surface thinking to
   `LlmResponse`, add `LlmResponse.thinking?: string` and concat blocks.
   Not in scope for spec-27 v0.

2. **Streaming**. None of turn / structured paths stream today. Adding
   streaming requires a separate `streamTurn` method on
   `LlmProtocolAdapter` and a streaming-aware `dispatchProvider` variant.
   Deferred until an app needs partial-token UI.

3. **Multi-tool-call response in structured path.** Anthropic and Gemini
   can emit multiple `tool_use` / `functionCall` blocks in one response.
   The structured strictness rule (§4) is "exactly one". This is the
   correct semantics for forced-single-tool admission (multiple = model
   ignored the forcing). But a future "structured + tool loop"
   composition (spec-25 §12.1.1 v0.2.10 constraint relaxation) will
   need a richer rule. Out of scope for v0.

4. **Adapter sharing across kinds**. cf-ai-binding and
   openai-chat-compatible share encode/decode/classify. Currently each
   adapter object holds its own references to the same pure functions.
   Acceptable for now; if more wires share shape, extract a helper module.
   Not an algebra issue.

5. **Gemini API key rotation via query param vs header.** v0 uses
   `x-goog-api-key` header. If an aggregator only supports `?key=`,
   register a separate `kind` or extend the route with a `authStyle`
   field. Defer.

6. **Typed turn-failure projection via `classify`.** v0 `callLlm`
   propagates dispatch failures as raw `UpstreamFailure { cause }` and
   does NOT invoke `adapter.classify`. submit-agent's existing abort
   taxonomy handles them. A future expansion would route turn errors
   through `classify` to drive adaptive retry (e.g. retry on
   `TransientError`, fast-fail on `AuthError`) without writing
   lease-bearing evidence. This needs a new turn-side abort kind
   carrying the `FailureClass`, plus a retry policy in submit-agent
   that consumes it. Out of scope until an app shows the existing
   "single upstream abort" surface is inadequate. Codex flagged this
   as spec/impl drift on 2026-05-25; §3.0.1 + §4 table now record the
   v0 scope so the spec matches the implementation.

---

## 12. Decision provenance

| Decision | Origin |
|---|---|
| Elevate Adapter to cover turn + structured (not admission-only) | Codex review 2026-05-25: "extending admission-only would leave callLlm broken for any non-Chat-Completions wire — same class of failure recurs on each new app" |
| OpenRouter route is honest, not a substitute | spec-27 review correction: routeFingerprint reflects wire identity; aggregators and native protocols are coexisting capability surfaces |
| `adapterVersion` bumps on any observable adapter change | spec-25 §9 generalized: single coherence dial |
| `ProviderRequestBodyFor<K>` (per-wire body), not single neutral shape | Keep adapter = protocol-translation, dispatcher = transport. Mixing them produced classify gradient collapse in earlier iterations |
| Default `anthropic-version` NOT in fingerprint, only pinned version is | Re-admission cost of bumping the default would be high and unnecessary for routes that did not pin |
| Anthropic + Gemini both register native protocols, not via openai-compat | C-3: native and aggregator are different capability surfaces. Apps that need Anthropic admission evidence MUST use anthropic-messages |
| spike-05 / spike-06 are real-provider validations, not unit-test substitutes | Spec-25's spike-04 verdict: unit tests cannot falsify wire-level assumptions; only real traffic can |

---

## Appendix A: Why not extend admission only

Tempting alternative: "add new wires only inside `admission.ts`; keep
`callLlm` on Chat Completions; apps that want anthropic/gemini turn loop
can use a separate code path".

Rejected:

1. **Class of failure recurs.** The next app needing turn-loop tool calls
   on Anthropic discovers the gap. The next app after that re-discovers it
   on Gemini. The class of failure ("turn path is wire-locked") is not
   eliminated by patching admission.

2. **Two adapter algebras evolve.** Admission-side adapter (admission.ts)
   would carry encode/decode/classify per wire; turn-side would carry its
   own. They would diverge — classify rules drift, decode helpers
   duplicate, version dials desynchronize. The single `adapterVersion`
   invariant (§5) would be impossible to enforce.

3. **`adapterId` integrity weakens.** spec-25 §11 made `adapterId` reflect
   "which transport actually served the call". If turn and structured
   used different adapters for the same wire, `adapterId` would have to
   distinguish them — extra surface, more failure modes.

4. **CLAUDE.md "Done" criterion fails.** A complete fix eliminates the
   class of failure by construction. Admission-only extension leaves the
   class alive.

---

## Appendix B: Minimal app-side example after migration

```ts
// app worker
export class MyAgent extends AgentDOBase<Env> {
  protected provideRegistry() {
    return {
      endpoints: {
        "anthropic-aihubmix": "https://aihubmix.com",
        "gemini-google":       "https://generativelanguage.googleapis.com",
      },
      credentials: {
        ANTHROPIC_KEY_AIHUBMIX: this.env.ANTHROPIC_KEY_AIHUBMIX,
        GEMINI_KEY:             this.env.GEMINI_KEY,
      },
    };
  }
}

// app code
await agent.submit({
  intent:  "plan a trip",
  context: { ... },
  route: {
    kind:          "anthropic-messages",
    endpointRef:   "anthropic-aihubmix",
    credentialRef: "ANTHROPIC_KEY_AIHUBMIX",
    modelId:       "claude-sonnet-4-6",
    // `anthropicVersion` is optional; omit to pool with the substrate's
    // current default (which IS part of the fingerprint via
    // normalization — bumping it invalidates this route's lease).
  },
  tools:        {},
  outputSchema: TripPlanSchema,
  deliver:      { event: "trip.planned" },
});
```

Switching to Gemini = change the `route` block only. The substrate's
admission, lease projection, deliver atomicity, and tool-loop semantics
are identical across all four registered wires.
