# agentOS Refactor Decisions

This file records decisions that are no longer open questions for the current
refactor group.

## Project Invariant

```text
one fact has one owner;
every internal algebra has one code source;
runtime validation is for unknown external input, not internally generated facts;
provider material stays resolver-side and never becomes ledger/projection truth;
external SDKs, protocols, tracing systems, and workflow frameworks are adapters
or projections, not durable truth.
```

## Confirmed Decisions

### D1: Effect Schema Is The Only Schema Source

Effect Schema becomes the canonical source for tool parameter schemas and
structured-output schemas.

Raw JSON Schema is no longer a public authoring surface for tools or structured
admission. JSON Schema remains only as a generated provider projection.

This decision does not automatically migrate every non-LLM substrate schema
surface. `BoundaryContract`, carrier payload declarations, and other non-tool /
non-admission schema declarations require an explicit source-owner decision
before deletion gates are widened.

### D2: AgentSchema Is The agentOS Schema Profile

agentOS will expose an `AgentSchema` profile over Effect Schema. The profile is
the gate for schemas that can be:

- projected to provider JSON Schema;
- decoded at runtime;
- fingerprinted stably;
- projected to Effect AI tools;
- projected to AG-UI tool JSON Schema.

Unsupported or lossy Effect Schema constructs fail at boot or construction time.

### D3: Effect AI Is Provider Projection Only

Effect AI replaces provider protocol projection after a86 proves schema source
migration. It does not own runtime state or tool execution.

agentOS keeps ownership of:

- `LlmRoute`;
- material refs and resolver boundary;
- route/schema/admission fingerprints;
- submit loop;
- quota/budget;
- ledger facts;
- admission evidence and leases;
- error taxonomy;
- execution domains.

### D4: `LlmTransport.call()` Remains The Runtime Boundary

No runtime caller supplies `LanguageModel` context or provider-native model
objects. The Effect AI adapter closes over provider clients/models internally
after resolving agentOS material refs.

### D5: Tool Calls Stay Unresolved Until agentOS Executes Them

Effect AI must not execute tool handlers. The adapter uses unresolved tool calls
and keeps execution inside agentOS submit/admit/quota/execution-domain flow.

### D6: Structured Admission Writes Evidence Only

Effect AI `generateObject` or forced-tool strategy may be the provider call
mechanism, but admission owns only capability evidence and invalidation.

Submit owns deliver events, token-budget decisions, abort facts, and completed
terminal facts.

### D7: No Legacy Compatibility Path

This is a breaking refactor. Old JSON-Schema-first APIs and old manual provider
protocol modules are deleted after parity is proven. Compatibility wrappers,
fallback parsers, and shadow paths are not retained.

### D8: AG-UI Is An Edge Adapter

AG-UI is a wire-compatible facade over typed runtime events. It is not the
runtime source of truth and does not replace agentOS tool or schema algebra.

AG-UI tool JSON Schema is generated from `AgentSchema`.

The AG-UI adapter has a framework-neutral core projection. React and Svelte
bindings are supported client consumption surfaces over the same core frames.
Neither binding owns runtime state, tool definitions, redaction policy, or
ledger facts.

### D9: Product Workspace Projections Stay Product-Owned

`workspace.file.*` events/projections remain product-owned until at least a
second fs-based product stabilizes the schema shape. a90 proves consumption, not
substrate absorption.

### D10: Provider Material Never Enters Ledger-Visible Facts

Provider URLs, credentials, provider-native client objects, and resolved material
values remain resolver-side. Ledger events, projections, docs examples, AG-UI
frames, and product API payloads carry only symbolic refs or non-secret metadata
that is explicitly allowed.

### D11: Runtime Mechanical Buffers Are Not Truth

`due_work` and `dispatch_outbox` are backend-owned mechanical buffers. Durable
audit truth is ledger events.

Product/run projections must not derive business state from these tables. Only
pump/redrive/ops lifecycle readers may inspect them.

### D12: Product UI Consumes Redacted Runtime Projection

Product APIs and UIs must not expose raw ledger payload pass-through for
agentOS-owned runtime events. UI-facing streams consume typed runtime projections
or AG-UI frames with an explicit redaction policy.

Tool args/results, provider metadata, file bytes, provider URLs, credentials,
and resolved material values are exposed only when the owning projection
explicitly allows them.

### D13: External Agent Frameworks Are Algebra References Only

Temporal, DBOS, Inngest, LangGraph, Microsoft Agent Framework, OpenAI Agents,
Vercel AI SDK, Mastra, CrewAI, AutoGen, AG-UI, MCP, A2A, LangSmith, Phoenix,
Braintrust, and OpenTelemetry are reference systems for useful algebra and
protocol shapes.

They do not become sources of agentOS durable truth. Their checkpoint tables,
conversation snapshots, UI messages, task histories, trace stores, and SDK
session state are external state unless agentOS explicitly commits a symbolic
fact into the ledger.

### D14: Durable Process State Is Ledger-Derived

Durable process/workflow concepts are modeled as ledger facts and derived
projections:

- process identity;
- command / awaitable intent;
- idempotent step or acquire boundary;
- wait / resume facts;
- terminal facts;
- projection rebuild cursor.

No arbitrary TypeScript or Effect workflow code is replayed as the source of
truth. External effects happen behind idempotent acquire/step boundaries and
commit terminal facts synchronously.

### D15: Provider Responses Normalize Through agentOS Output Items

Provider responses normalize into an agentOS-owned provider output item ADT
before submit, admission, settlement, or projection logic consumes them.

OpenAI Responses-style `message`, `reasoning`, `function_call`, and
`function_call_output` parts are treated as the reference shape. Chat-shaped
provider payloads, Effect AI response parts, and provider-native SDK objects are
adapter inputs, not runtime facts.

Provider-executed tools are not agentOS app tool executions. If a hosted or
provider-executed tool becomes relevant to durable behavior, agentOS records a
symbolic provider-tool fact or proof ref with a distinct owner.

### D16: Trace Context Propagates, OTLP Exports

agentOS propagates W3C `traceparent` / `tracestate` across runtime, dispatch,
tool, and execution-domain boundaries.

Trace context is correlation metadata, not durable business truth. OTLP and
OpenTelemetry GenAI semantic conventions are exporter/projection mappings over
agentOS facts and projections. Prompts, completions, tool payloads, file bytes,
provider URLs, credentials, and provider-native metadata are not exported unless
an explicit redaction/visibility policy allows them.

Generic dataset/experiment/scorer/rubric substrate is deferred. Existing
verification proof refs remain the narrow substrate shape until at least two
first-party workflows need durable non-binary eval evidence.

### D17: Web-Cursor Is Consumer Pressure, Not Substrate Staging

`/Users/yansir/code/52/web-cursor-workspace-spike` is the primary consumer proof
app for the refactor group.

It may prove product consumption of `AgentSchema`, typed runtime projections,
AG-UI frames, standard workspace tools, and redacted product APIs. It does not
own substrate event vocabulary, runtime schemas, AG-UI mapping semantics, or
workspace carrier promotion.

Any product-side fallback parser for agentOS-owned runtime payloads is evidence
of a substrate surface failure. The class-level fix belongs in agentOS typed
schemas/projections/adapters, not in product inference code.

`workspace.file.*` remains product-owned until a second fs-based product
stabilizes the same digest/source/removed/hidden-file semantics.

## Not Decisions Yet

The following are intentionally left to spike validation:

- stable schema fingerprint algorithm;
- exact `AgentSchema` supported subset;
- whether raw JSON Schema is deleted globally or only from tool/admission
  authoring;
- OpenAI Responses route vs chat-compatible route;
- `cf-ai-binding` delete vs explicit custom route;
- abort propagation through Effect AI provider clients;
- Gemini/OpenAI protocol metadata durability boundary;
- structured-output native vs forced-tool strategy per provider;
- AG-UI package/version and whether web-cursor renders only from AG-UI frames;
- React/Svelte binding package shapes for AG-UI consumption;
- `write_file` / `edit_file` / `glob_files` / `grep_files` exact workspace tool
  semantics;
- Cloudflare DO alarm/fanout/hibernation edge contracts.
