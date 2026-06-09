# @agent-os/telemetry-protocol

## Purpose

Backend-neutral telemetry vocabulary shared by runtime, backend protocol, and backend interpreters.

## Invariant

Telemetry semantics have one owner. Runtime and backend packages may emit or project telemetry, and wire adapters may convert telemetry to OTLP or vendor protocols, but trace context validation and agentOS telemetry tree shape live in this package.

## Minimal Usage

Runtime and backend implementations import trace context schemas and telemetry tree types from `@agent-os/telemetry-protocol`. Kernel packages do not depend on telemetry vocabulary.

## Verification

Run the package and graph gates:

```sh
cd packages/telemetry-protocol && bun run test
bun run typecheck
```
