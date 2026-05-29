# @agent-os/backend-protocol

## Purpose

Storage-free backend protocol algebra shared by concrete backend implementations.

## Invariant

Backend protocol semantics have one owner. Concrete backends may materialize storage, alarm, and transport, but they must not redefine dispatch vocabulary, retry policy, due-work kinds, payload parsing, or event-handler fanout policy.

## Minimal Usage

Backend implementations import protocol constants and helpers from `@agent-os/backend-protocol`; application, carrier, and runtime packages do not depend on it.

## Verification

Run the backend protocol consumers through their package gates:

```sh
cd packages/backends/cloudflare-do && bun run typecheck && bun run test
cd packages/backends/in-memory && bun run typecheck && bun run test
```
