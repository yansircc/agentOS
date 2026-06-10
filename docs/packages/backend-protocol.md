# @agent-os/backend-protocol

## Purpose

Storage-free backend protocol algebra shared by runtime services and concrete backend implementations.

## Invariant

Backend protocol semantics have one owner. Runtime services and concrete backends may consume the protocol DTOs and helpers, but they must not redefine dispatch vocabulary, scheduled trigger vocabulary, retry policy, intent-pointer payload parsing, scheduled intent payload parsing, resource/quota projection shapes, or event-handler fanout policy. Runtime may implement trigger execution, but durable schedule intent vocabulary and due-work discriminators live here.

## Minimal Usage

Runtime services and backend implementations import protocol constants, port DTOs, and helpers from `@agent-os/backend-protocol`. Application and carrier packages do not depend on it.

Effectful reference helpers are opt-in through `@agent-os/backend-protocol/reference`; the main entry remains vocabulary-only.

## Verification

Run the backend protocol consumers through their package gates:

```sh
cd packages/backends/cloudflare-do && bun run typecheck && bun run test
cd packages/backends/in-memory && bun run typecheck && bun run test
```
