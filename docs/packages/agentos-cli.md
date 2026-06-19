# AgentOS CLI

## Purpose

`@agent-os/agentos-cli` is the private repo-local command entrypoint for
generated projections and boundary rule checks.

## Invariant

The CLI consumes source facts and runs owner gates. It does not own package
facts, public API intent, carrier declarations, or substrate runtime behavior.

## Minimal Usage

```sh
bun run agentos -- check all
bun run agentos -- check guard public-api
bun run agentos -- generate docs
```

## Verification

```sh
bun run agentos -- --help
bun run agentos -- check guard ag-ui-sse-axis
```
