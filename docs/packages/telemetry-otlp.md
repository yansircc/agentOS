# @agent-os/telemetry-otlp

## Purpose

OTLP projection adapter for agentOS telemetry event trees.

## Invariant

agentOS telemetry semantics are owned by `@agent-os/telemetry-protocol`.
This package only maps `TelemetryEventTree` nodes into OTLP span DTOs and
OpenTelemetry semantic-convention attributes.

## Minimal Usage

Call `projectOtlpSpans(tree)` with a `TelemetryEventTree` and send the returned
spans to an OTLP exporter owned outside runtime core.

## Verification

Run the package and graph gates:

```sh
cd packages/wire-adapters/telemetry-otlp && bun run test
bun run typecheck
```
