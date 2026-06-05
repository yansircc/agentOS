# agentOS Refactor Spike Validation Plan

This file lists unresolved facts that must be proven before the corresponding
breaking task lands. If a spike fails, update the owning task before writing
production code.

## S1: AgentSchema Profile + Fingerprint

stable axis: Effect Schema is the only schema source.  
change axis: supported schema subset and fingerprint projection.  
invariant: schema fingerprint is generated from an agentOS-owned stable
projection, not from unstable library internals.

Questions:

- Which Effect Schema constructs are in the `AgentSchema` profile?
- Is the fingerprint based on canonical provider JSON Schema or a canonical
  agentOS schema projection?
- Do annotation-only changes affect fingerprints?
- What happens when the Effect dependency version changes?

Proof:

- equivalent schemas hash identically;
- semantic changes hash differently;
- unsupported schemas fail with targeted errors;
- dependency bump either preserves hashes by proof or changes fingerprint
  algorithm prefix;
- raw JSON Schema tool/admission authoring fails at typecheck and boot.

Owning task: `tasks/a86a-agent-schema-profile-spike.md`.

## S2: Provider JSON Schema Projection

stable axis: AgentSchema is source.  
change axis: provider-specific JSON Schema requirements.  
invariant: provider JSON Schema is a derived projection and never an authoring
input.

Questions:

- Can the same `AgentSchema` produce OpenAI, Anthropic, Gemini, AG-UI, and
  structured-output projections?
- Which providers require strict mode, `additionalProperties`, required fields,
  enum normalization, or OpenAPI-style conversion?

Proof:

- golden projections for representative object/string/number/boolean/array/enum
  schemas;
- provider strict-mode fixture;
- no product-authored raw JSON Schema accepted.

## S3: Effect AI Provider Parity

stable axis: `LlmTransport.call()` is the runtime boundary.  
change axis: provider protocol implementation.  
invariant: Effect AI adapter preserves agentOS `LlmResponse` and route/material
semantics.

Questions:

- Is parity satisfied for OpenAI-compatible, Anthropic, and Gemini?
- Is `openai-chat-compatible` still sufficient, or is `openai-responses` a new
  route?
- Is `cf-ai-binding` deleted or named as custom non-Effect-AI route?
- Which provider/package/adapter versions enter route/admission fingerprints?
- Does every supported provider route expose required usage counts, or must the
  route remain custom/unsupported?

Proof:

- request/response golden fixtures per provider;
- `openai-chat-compatible` is either proven against Effect AI with the same
  chat-completions semantics, or a separate `openai-responses` route/fingerprint
  is introduced;
- tool call id/name/JSON args round-trip;
- usage hard-fail when prompt/completion/total tokens are missing;
- zero-usage fallback fixtures are deleted before old protocol code is removed;
- no resolved provider material appears in events/projections/logs;
- explicit `cf-ai-binding` decision recorded.

## S4: Abort Propagation

stable axis: submit owns timeout/cancellation terminal facts.  
change axis: provider client implementation.  
invariant: cancellation either aborts provider work or is explicitly documented
as bookkeeping-only for that route.

Questions:

- Does Effect interruption close the underlying HTTP request?
- Does Cloudflare Worker/DO runtime observe the cancellation?
- Which routes are truly abortable?

Proof:

- slow local provider sees connection/request cancellation;
- the proof runs through Effect interruption, not only through direct `fetch`
  signal passing;
- submit writes exactly one abort terminal event;
- no `llm.response` or completed event after abort;
- route matrix marks any bookkeeping-only cancellation path.

## S5: Unresolved Tool Calls

stable axis: agentOS owns tool execution.  
change axis: Effect AI tool projection.  
invariant: provider may request tool calls; Effect AI does not execute them.

Questions:

- Does `disableToolCallResolution: true` prevent all handler execution?
- Can multiple tool calls per turn be represented without loss?
- Are partial/streamed tool arguments supported or explicitly rejected?

Proof:

- sentinel tool handler fails the test if called;
- multi-tool call fixture preserves ids/names/args;
- provider-executed tool results are rejected, not normalized as agentOS tool
  results;
- tool-result prompt conversion fails if the resulting provider message would
  contain an empty tool name;
- streamed/partial args decision documented with provider fixtures.

## S6: Structured Admission Strategy

stable axis: admission writes evidence only; submit writes deliver/terminal.  
change axis: Effect AI structured output mechanism.  
invariant: provider mechanism cannot own capability evidence or product delivery.

Questions:

- Does each provider use native structured output, forced tool, or another mode?
- Which strategy facts enter `AttemptKey`?
- How are decode/provider errors mapped to admission outcomes?
- If native structured output is used, does it get a distinct strategy key from
  forced `_submit_structured` tool evidence?

Proof:

- provider-by-provider structured strategy matrix;
- changing strategy/adapter/provider version rekeys evidence;
- forced-tool parity uses `generateText` plus forced `_submit_structured` and
  unresolved tool calls; native structured output uses a different strategy key;
- structured success writes evidence only in admission and deliver/completed in
  submit;
- over-token path writes evidence plus one budget abort, no deliver/completed.

## S7: Provider Metadata Round-Trip

stable axis: provider metadata is not provider material.  
change axis: metadata needed for future turns.  
invariant: only explicitly allowed opaque protocol metadata may become durable.

Questions:

- Is Gemini `thoughtSignature` stored durably or kept provider-local?
- Do OpenAI reasoning items need replay state?
- What is the redaction rule for provider metadata in ledger/AG-UI/product UI?

Proof:

- multi-turn Gemini and OpenAI tool-call replay fixtures;
- Gemini fixture includes a tool call with `thoughtSignature`, stores only the
  allowlisted metadata, and replays it on the second turn;
- sentinel provider URL/credential/file-content does not appear in events,
  projections, AG-UI frames, or UI JSON;
- allowed metadata fields are documented.

## S8: AG-UI Wire Projection

stable axis: runtime events are source of truth.  
change axis: external wire protocol for UI clients.  
invariant: AG-UI frames are projections, not runtime facts.

Questions:

- Which exact `@ag-ui/core` version is pinned?
- Does web-cursor render from AG-UI frames only, or is AG-UI only external
  compatibility?
- Which runtime fields survive mapping?
- How are product-owned events represented?

Proof:

- runtime transcript -> AG-UI frames golden fixtures;
- exact `@ag-ui/core` / `@ag-ui/client` versions are pinned, or a recorded wire
  fixture is vendored as the compatibility contract;
- web-cursor UI renders one golden run through the chosen path;
- `AgentSchema -> AG-UI Tool.parameters` projection test;
- malformed runtime payload fails before AG-UI mapping.

## S9: Cloudflare DO Runtime Edge Contracts

stable axis: ledger/storage/projectors own durable truth.  
change axis: Cloudflare DO execution, alarms, and streaming facade.  
invariant: memory, alarms, and fanout are operational mechanisms, not source
facts.

Questions:

- Does post-commit fanout failure leave committed ledger facts intact?
- Are all `transactionSync` boundaries synchronous?
- Do alarms/redrive/cancel race cases still commit at most one terminal?
- Can run state rebuild after DO hibernation/restart?

Proof:

- sink throws after commit; ledger rows still readable and diagnostics record
  fanout failure;
- static/lint gate for no async in transaction boundary;
- race tests: blocked acquire, cancel while claimed, expired redrive, late first
  completion, duplicate drain;
- simulate a new DO instance with the same storage after a claimed row; draining
  at the claim deadline commits at most one terminal;
- alarm handler failure does not strand pending due rows after retry exhaustion;
  code either catches/re-arms or documents a finite retry risk;
- simulated restart rebuilds runTrace/runStatus/runs from storage.

## S10: Web-Cursor Product Proof

stable axis: product owns prompts, UI state, and `workspace.file.*`.  
change axis: consumption of new agentOS schemas/runtime/AG-UI/workspace tools.  
invariant: product consumes typed substrate facts and does not parse agentOS
runtime payloads.

Questions:

- What is the smallest product-valid natural-language loop?
- Is `edit_file`, `write_file`, or both the model-facing edit surface?
- What are glob/grep hidden-file, binary, truncation, and sorting semantics?
- How is stale workspace projection reconciled?

Proof:

- inspect -> grep/glob -> edit/write -> verify -> terminal UI live smoke;
- captured run id, terminal event id, UI screenshot, and workspace diff;
- fixture workspace for hidden/large/binary/many-match files;
- stale projection + missing sandbox file reconciliation test;
- no `as unknown`, no raw JSON Schema, no runtime payload fallback parser;
- product API/UI consumes a redacted typed run projection or AG-UI frames, not
  raw ledger payload pass-through.

## S11: Public API, Distribution, And No-Legacy Release Gate

stable axis: public API and docs facts have one writer.  
change axis: breaking release surface.  
invariant: no hidden legacy export, test seam, or tracked spike becomes public
surface.

Questions:

- Which exports are intentionally deleted?
- Is public API intent owned by source TSDoc or manual docs?
- Are 0.2 ledgers/data intentionally unsupported after the break?
- Are testing seams and spike apps excluded from distribution?

Proof:

- public API before/after diff;
- docs generated from the owned source only;
- `npm pack --dry-run` / distribution check;
- consumer fixture cannot import deleted/test-only surfaces;
- `git ls-files spikes` contains only allowed placeholders.
