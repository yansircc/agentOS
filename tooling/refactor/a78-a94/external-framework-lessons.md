# External Framework Lessons

## Summary

stable axis: agentOS ledger facts, typed projections, BoundaryContract,
AgentSchema, material refs, and execution domains are the source of truth.  
change axis: external agent frameworks, protocols, provider SDKs, tracing
systems, workflow runtimes, and UI bindings.  
invariant: borrow algebra and compatibility shapes; do not import external
runtime state as agentOS truth.

This file records the read-only web research outcome that produced a92-a94.

## Borrow Now

### Durable Process Algebra

Reference systems: Temporal, DBOS, Inngest, LangGraph, Microsoft Agent
Framework.

Borrow:

- deterministic orchestration emits commands;
- external effects run as idempotent steps/acquires;
- checkpoint identity is a cursor, not durable truth;
- human approval / interruption / request ports are wait-resume facts;
- graph topology is authoring syntax that compiles to commands and ledger facts.

Do not borrow:

- external workflow histories as ledger truth;
- whole-code replay of arbitrary TypeScript / Effect code;
- checkpoint tables as process state;
- durable workflows absorbing live stream frames by default.

Task: `tasks/a92-durable-process-algebra.md`.

### Provider Output Item ADT

Reference systems: OpenAI Responses, Effect AI, Vercel AI SDK, Mastra.

Borrow:

- typed output item vocabulary for messages, reasoning, tool/function calls, and
  function-call outputs;
- schema-first tool authoring;
- provider-as-adapter construction;
- unresolved tool calls when the application owns tool execution.

Do not borrow:

- chat-completions-only runtime shape for new surfaces;
- provider SDK response classes as runtime facts;
- framework auto-execute tool handlers as substrate default;
- provider sessions, snapshots, or `previous_response_id` as durable truth.

Task: `tasks/a93-provider-output-item-adt.md`.

### Protocol Projection

Reference systems: AG-UI, MCP, OpenAI Apps SDK, A2A.

Borrow:

- AG-UI event grammar and snapshot/delta stream pairing;
- MCP `tools/list`, `tools/call`, `structuredContent`, and tool annotations as
  descriptor hints;
- OpenAI Apps SDK channel split between descriptor metadata, visible content,
  structured content, component-only `_meta`, and CSP/resource metadata;
- A2A AgentCard / Task / Artifact as remote-agent API projections.

Do not borrow:

- AG-UI frontend tool definitions as source truth;
- MCP `_meta` as a secret store;
- Apps SDK compatibility aliases as source facts;
- A2A task history, push payloads, or metadata as ledger truth;
- unregistered `Raw`, `Custom`, `_meta`, or extension namespaces that can affect
  durable state.

Existing task: `tasks/a84-ag-ui-wire-adapter.md`.

### Trace Context And OTLP Projection

Reference systems: W3C Trace Context, OpenTelemetry, LangSmith, Phoenix,
Braintrust, Mastra, CrewAI.

Borrow:

- W3C `traceparent` / `tracestate` propagation;
- OTLP exporter as a projection over run/tool/dispatch/verification facts;
- versioned OpenTelemetry GenAI semantic-convention mapping;
- trace-linked proof refs for debugging and verification.

Do not borrow:

- tracing vendor stores as substrate truth;
- prompts, completions, file bytes, provider URLs, credentials, or provider
  metadata in exported spans by default;
- generic dataset / experiment / scorer / rubric substrate before product
  pressure proves it.

Task: `tasks/a94-trace-context-otlp-projection.md`.

## Defer

- Generic eval substrate. Trigger: two first-party workflows require durable
  non-binary eval evidence that cannot be represented as verification proof
  refs.
- Durable stream logs. Trigger: product UX requires reconnect/resume for long
  sessions and token/frame replay.
- Workflow graph DSL. Trigger: at least two process patterns repeat the same
  command/wait/fan-out/fan-in algebra and cannot stay clear as direct trigger
  definitions.

## Implementation Rule

External compatibility is always a generated adapter/projection:

```text
agentOS source algebra -> typed projection -> external protocol / SDK shape
```

The reverse direction is allowed only at unknown external boundaries, where
runtime decoding validates input before it becomes an agentOS fact.
