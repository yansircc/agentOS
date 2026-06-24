# AgentOS CLI

## Purpose

`@agent-os/cli` is the developer command package for generated projections,
authored agent builds, structural checks, and distribution gates.

## Invariant

The CLI consumes source facts and executes gates. It does not own package
facts, public API intent, carrier declarations, ledger identity, or substrate
runtime behavior.

## Minimal Usage

```sh
pnpm run agentos check all
pnpm run agentos check guard public-api
pnpm run agentos build --cwd /path/to/app
pnpm run agentos generate docs
```

## Verification

```sh
pnpm run agentos --help
pnpm run agentos check guard ag-ui-sse-axis
```
