# a94: Trace Context Propagation and OTLP Projection

## Summary

stable axis: ledger facts, symbolic refs, redacted runtime projections, and
verification proofs are agentOS truth.  
change axis: tracing vendors, OTLP exporters, OpenTelemetry GenAI semantic
convention versions, and product-specific eval tooling.  
invariant: trace context is correlation metadata; observability exporters are
projections and cannot become durable truth.

This task borrows from W3C Trace Context, OpenTelemetry, LangSmith, Phoenix,
Braintrust, Mastra, and CrewAI observability/eval patterns without adopting their
trace stores, datasets, scorers, or experiment registries as substrate state.

## Key Changes

- Add a trace propagation contract:
  - runtime submit envelope;
  - dispatch envelope;
  - tool execution envelope;
  - execution-domain boundary;
  - Durable Object facade / RPC paths where applicable.
- Preserve W3C `traceparent` and `tracestate` verbatim across boundaries, or
  fail validation when malformed context would be propagated.
- Do not define an agentOS span model in the ledger.
- Add an OTLP exporter/projection adapter that derives spans from existing
  ledger/run/claim/projection state:
  - agent run;
  - LLM/provider call;
  - tool execution;
  - dispatch delivery;
  - durable trigger step/acquire;
  - verification gate;
  - execution-domain boundary.
- Version the OpenTelemetry GenAI semantic-convention mapping. Treat the mapping
  as exporter config, not kernel vocabulary.
- Keep prompts, completions, tool args/results, file bytes, provider URLs,
  credentials, and provider-native metadata out of exported spans by default.
  Export content only through an explicit visibility/redaction policy and
  external content refs.
- Defer generic dataset/experiment/scorer/rubric substrate. Existing
  verification carrier proof refs remain the narrow evaluation substrate until
  two first-party workflows need durable non-binary eval evidence.

## Tests

- Valid `traceparent`/`tracestate` propagates through submit -> dispatch -> tool
  execution -> runtime projection.
- Malformed trace context fails at the boundary where it would otherwise be
  propagated.
- OTLP exporter emits spans from projections without writing ledger events.
- Exported span ordering is derived from ledger ids / projection cursors.
- Redaction sentinel proves prompts, completions, file bytes, provider URLs,
  credentials, resolved material values, and non-allowlisted provider metadata
  are absent from spans by default.
- GenAI semantic-convention version changes require fixture regeneration and
  semantic diff review.
- Verification proof refs can correlate with trace ids without importing
  dataset/scorer/rubric concepts into substrate.

## Gates

Full root gates plus focused propagation/redaction fixtures.

Exporter snapshots are completeness gates and may run at wave close-out. Trace
context propagation and redaction gates are source-owner gates and must land
with this task.

## Assumptions

- Tracing vendors and observability dashboards are optional sinks.
- OTLP export failures cannot reject already-committed ledger facts.
- Evaluation platform concepts stay product-owned unless the deferred trigger
  for durable non-binary eval evidence is met.
