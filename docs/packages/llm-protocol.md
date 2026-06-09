# @agent-os/llm-protocol

## Purpose

Provider-neutral LLM request, response, route, and wire descriptor vocabulary shared by runtime and LLM provider interpreters.

## Invariant

LLM protocol semantics have one owner. Kernel owns generic agentOS ref, schema, material, and tool algebra; concrete LLM provider adapters may understand provider wire protocols, but protocol-level request/response shape and fingerprintable wire descriptors live here without provider package imports or provider-named fields.

## Minimal Usage

Runtime and provider implementations import LLM request/response types, route material-ref extraction, and wire descriptor helpers from `@agent-os/llm-protocol`.

## Verification

Run the package and graph gates:

```sh
cd packages/llm-protocol && bun run test
bun run typecheck
```
